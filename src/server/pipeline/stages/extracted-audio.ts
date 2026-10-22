import { monotonicFactory } from "ulid";
import { EXTRACT_AUDIO_UNIT_KEY, FETCH_AUDIO_UNIT_KEY } from "../../../shared/work-steps.ts";
import { amberError, isAmberError } from "../../domain/errors.ts";
import type { MediaAsset } from "../../domain/media-asset.ts";
import type { FileStore } from "../../ports/file-store.ts";
import type { LocalMediaIngest } from "../../ports/local-media-ingest.ts";
import type { Repository } from "../../ports/repository.ts";
import type { StageExecutionContext } from "../executor.ts";
import type { MediaFiles } from "../media-files.ts";
import { platformTarget, type PlatformAccess, type PlatformTarget } from "./platform-access.ts";
import type { ProgressSink } from "./progress.ts";
import { assetPath, assetRef, availableMediaSource, markMissing, singleStore } from "./source-media.ts";

export interface ExtractedAudioDeps {
  repository: Repository;
  /** The data store: the Task's own `extracted_audio` / `temporary` files always live here. */
  files: FileStore;
  /** Where the source is read from by its kind (a cached video may sit on another volume); defaults to `files` for every kind. */
  media?: Pick<MediaFiles, "storeFor">;
  ingest: LocalMediaIngest;
  /** Platform Contents without a cached video download their audio through here. */
  platforms?: PlatformAccess;
  now?: () => number;
  newId?: () => string;
}

/**
 * Where the caller wants the progress of each step, already mapped onto its own stage's
 * progress; a step without a sink reports nothing.
 */
export interface ExtractedAudioProgress {
  /** The platform audio download, in [0, 1]. */
  fetch?: ProgressSink;
  /** The extraction after a platform audio download, in [0, 1]. */
  extract?: ProgressSink;
  /**
   * The extraction when there is nothing to download (a local file or a cached video), in
   * [0, 1]; defaults to `extract`. Lets the caller give the download's share to it.
   */
  extractAlone?: ProgressSink;
}

const FLAC_MIME = "audio/flac";
/** yt-dlp's `ba/b` picks whatever container the platform serves; ffmpeg reads it by content. */
const DOWNLOADED_MIME = "application/octet-stream";

/**
 * On-demand audio for the stages that send it to a model: reuses the Task's
 * `extracted_audio` when its file is still there, otherwise extracts mono 16 kHz FLAC as
 * a file-backed WorkUnit of the calling stage, under the heavy semaphore. The source is
 * the original local file or a cached platform video; a platform Content without a cache
 * first downloads its audio (`ba/b`) into a `temporary` asset. Assets are registered after
 * their file is committed; they belong to the Task and go when it ends.
 * A step skipped because its output is already there reports no progress.
 */
export async function ensureExtractedAudio(
  context: StageExecutionContext,
  deps: ExtractedAudioDeps,
  progress?: ExtractedAudioProgress,
): Promise<{ asset: MediaAsset; path: string }> {
  const { task } = context;
  const owner = task.userId;
  const contentId = task.contentId;
  if (contentId === undefined) {
    throw new TypeError("audio extraction needs a Content target");
  }
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? monotonicFactory();

  const existing = deps.repository.withTransaction((scope) =>
    scope.mediaAssets.listByTask(owner, task.id).filter((asset) => asset.kind === "extracted_audio" && asset.availability === "available"),
  );
  for (const asset of existing.reverse()) {
    if ((await deps.files.stat(asset.storageRef)) !== null) {
      return { asset, path: deps.files.pathOf(asset.storageRef) };
    }
  }

  const content = deps.repository.withTransaction((scope) => scope.contents.getIncludingTrashed(owner, contentId));
  let source = deps.repository.withTransaction((scope) => availableMediaSource(scope, owner, contentId));
  const extractProgress = source === undefined ? progress?.extract : (progress?.extractAlone ?? progress?.extract);
  if (source === undefined) {
    const target = deps.platforms === undefined || content === undefined ? undefined : platformTarget(deps.platforms, content);
    if (target === undefined) {
      throw amberError("media_missing", "no original media to extract audio from");
    }
    source = await downloadPlatformAudio(context, deps, target, contentId, newId, now, progress?.fetch);
  }
  const input = source;
  const durationMs = input.durationMs ?? content?.durationMs;
  let extracted: { sizeBytes: number; durationMs: number } | undefined;
  const output = await context.runUnit({
    key: EXTRACT_AUDIO_UNIT_KEY,
    inputDigest: input.fingerprint ?? `asset:${input.id}`,
    storage: "file",
    run: (signal) =>
      context.withHeavySlot(async () => {
        const ref = assetRef({ userId: owner, contentId, id: newId() });
        const stored = await deps.files.writeAtomic(ref, async (partial) => {
          extracted = await extractFrom(deps, input, partial, signal, { ...(durationMs === undefined ? {} : { durationMs }), ...(extractProgress === undefined ? {} : { onProgress: extractProgress }) });
        });
        return { outputRef: ref, outputDigest: stored.digest };
      }),
  });

  const ref = output.outputRef;
  const sizeBytes = extracted?.sizeBytes ?? (await deps.files.stat(ref))?.sizeBytes ?? 0;
  const asset = deps.repository.withTransaction((scope) => {
    const registered = scope.mediaAssets.listByTask(owner, task.id).find((candidate) => candidate.storageRef === ref);
    if (registered !== undefined) {
      return registered;
    }
    const created: MediaAsset = {
      id: ref.slice(ref.lastIndexOf("/") + 1),
      userId: owner,
      contentId,
      kind: "extracted_audio",
      taskId: task.id,
      storageRef: ref,
      mimeType: FLAC_MIME,
      sizeBytes,
      ...(extracted === undefined ? {} : { durationMs: extracted.durationMs }),
      availability: "available",
      retentionPolicy: "ephemeral",
      createdAt: now(),
    };
    scope.mediaAssets.insert(created);
    return created;
  });
  return { asset, path: deps.files.pathOf(ref) };
}

async function extractFrom(
  deps: ExtractedAudioDeps,
  source: MediaAsset,
  partial: string,
  signal: AbortSignal,
  options: { durationMs?: number; onProgress?: ProgressSink },
) {
  try {
    return await deps.ingest.extractAudio({ path: assetPath(source, deps.media ?? singleStore(deps.files)) }, { path: partial }, signal, options);
  } catch (error) {
    if (isAmberError(error) && error.appError.class === "media_missing") {
      markMissing(deps.repository, source);
    }
    throw error;
  }
}

/** The Task's downloaded platform audio, fetched once as a file-backed WorkUnit and kept as a `temporary` asset. */
async function downloadPlatformAudio(
  context: StageExecutionContext,
  deps: ExtractedAudioDeps,
  target: PlatformTarget,
  contentId: string,
  newId: () => string,
  now: () => number,
  onProgress: ProgressSink | undefined,
): Promise<MediaAsset> {
  const { task } = context;
  const owner = task.userId;
  const existing = deps.repository.withTransaction((scope) =>
    scope.mediaAssets.listByTask(owner, task.id).filter((asset) => asset.kind === "temporary" && asset.availability === "available"),
  );
  for (const asset of existing.reverse()) {
    if ((await deps.files.stat(asset.storageRef)) !== null) {
      return asset;
    }
  }
  let sizeBytes: number | undefined;
  const output = await context.runUnit({
    key: FETCH_AUDIO_UNIT_KEY,
    inputDigest: `platform:${target.adapter.kind}:${target.ref.platformContentId}:${target.ref.platformPartId ?? ""}`,
    storage: "file",
    run: (signal) =>
      context.withHeavySlot(async () => {
        const ref = assetRef({ userId: owner, contentId, id: newId() });
        const stored = await deps.files.writeAtomic(ref, async (partial) => {
          ({ sizeBytes } = await target.adapter.fetchAudio(target.ref, target.auth, { path: partial }, (value) => onProgress?.(value), signal));
        });
        return { outputRef: ref, outputDigest: stored.digest };
      }),
  });
  const ref = output.outputRef;
  const size = sizeBytes ?? (await deps.files.stat(ref))?.sizeBytes ?? 0;
  return deps.repository.withTransaction((scope) => {
    const registered = scope.mediaAssets.listByTask(owner, task.id).find((candidate) => candidate.storageRef === ref);
    if (registered !== undefined) {
      return registered;
    }
    const created: MediaAsset = {
      id: ref.slice(ref.lastIndexOf("/") + 1),
      userId: owner,
      contentId,
      kind: "temporary",
      taskId: task.id,
      storageRef: ref,
      mimeType: DOWNLOADED_MIME,
      sizeBytes: size,
      fingerprint: output.outputDigest,
      availability: "available",
      retentionPolicy: "ephemeral",
      createdAt: now(),
    };
    scope.mediaAssets.insert(created);
    return created;
  });
}
