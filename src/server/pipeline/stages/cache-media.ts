import { createHash } from "node:crypto";
import { cacheExtensionOf, cacheFileNameOf, cacheRef, isCacheRef } from "../../../shared/cache-file-name.ts";
import { CACHE_AUDIO_MP3_KBPS, CACHE_MEDIA_MAX_GB } from "../../../shared/defaults.ts";
import { BYTES_PER_GB, formatBytes } from "../../../shared/units.ts";
import type { Content } from "../../domain/content.ts";
import { amberError, type AmberError } from "../../domain/errors.ts";
import { isAudioCache, isVideoCache, type MediaAsset } from "../../domain/media-asset.ts";
import { cacheMediaTaskRequestSchema, type CacheMediaTaskRequestV2 } from "../../domain/task-request.ts";
import { FileTooLargeError, type FileStore } from "../../ports/file-store.ts";
import type { LocalMediaIngest } from "../../ports/local-media-ingest.ts";
import type { Logger } from "../../ports/logger.ts";
import type { Repository } from "../../ports/repository.ts";
import { belowWatermark } from "../disk-watermark.ts";
import type { StageExecutionContext, StageExecutor, StageOutcome } from "../executor.ts";
import type { MediaFiles } from "../media-files.ts";
import type { InstanceSettingsSource } from "../scheduler.ts";
import { platformTarget, taskContent, type PlatformAccess, type PlatformTarget } from "./platform-access.ts";
import { monotonic } from "./progress.ts";

export interface CacheMediaStageDeps {
  repository: Repository;
  /**
   * The cache store holds every `platform_cache` file; the data store holds
   * the downloaded audio track while it is transcoded.
   */
  media: Pick<MediaFiles, "cache" | "data">;
  platforms: PlatformAccess;
  ingest: Pick<LocalMediaIngest, "transcodeAudio">;
  /** The low-water mark the audio budget is checked against. */
  settings: InstanceSettingsSource;
  /** Whether the data directory and the cache directory are on one volume, so the download and the MP3 draw on the same free space. */
  sameVolume: () => boolean | Promise<boolean>;
  /** Refs of purged caches still waiting to be removed from the current cache directory; their names stay taken. */
  pendingCacheRefs?: () => ReadonlySet<string>;
  /** Runs after a new cache is registered; returns the ids it evicted. */
  evict: (ownerUserId: string, keepAssetId: string) => Promise<string[]>;
  /** Defaults to `CACHE_MEDIA_MAX_GB`. */
  maxBytes?: number;
  logger?: Logger;
  now?: () => number;
}

type CacheMediaType = CacheMediaTaskRequestV2["type"];

const DOWNLOAD_UNIT_KEY = "cache_media:download";
const MP4_MIME = "video/mp4";
const WEBM_MIME = "video/webm";
const MP3_MIME = "audio/mpeg";
/** The share of an audio cache's progress taken by the download; the transcode takes the rest. */
const AUDIO_DOWNLOAD_PROGRESS_SHARE = 0.7;
/** Headroom over the nominal MP3 size in the disk budget: container overhead and rounding. */
const MP3_SIZE_MARGIN = 1.1;
/**
 * Where the audio track waits for its transcode: the data directory's platform scratch
 * directory, whose leftovers the start-up sweep removes.
 */
const AUDIO_SCRATCH_DIR = "tmp/platform";

function tooLarge(maxBytes: number): AmberError {
  return amberError("media_too_large", `media exceeds ${maxBytes} bytes`, { params: { limit: formatBytes(maxBytes) } });
}

/** Windows compares file names case-insensitively; so does the guard against a taken name. */
function foldCase(name: string): string {
  return name.toLowerCase();
}

/**
 * The container of a committed download, for a unit completed by an earlier attempt whose
 * adapter answer is gone: ISO BMFF carries `ftyp` at offset 4, Matroska / WebM starts
 * with the EBML magic, MP3 with an ID3v2 tag or an MPEG audio frame sync (11 set bits).
 */
export async function sniffMime(files: Pick<FileStore, "read">, ref: string): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of files.read(ref, { start: 0, end: 11 })) {
    chunks.push(chunk);
  }
  const head = Buffer.concat(chunks);
  if (head.subarray(4, 8).toString("latin1") === "ftyp") {
    return MP4_MIME;
  }
  if (head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return WEBM_MIME;
  }
  if (head.subarray(0, 3).toString("latin1") === "ID3" || (head.length >= 2 && head[0] === 0xff && ((head[1] as number) & 0xe0) === 0xe0)) {
    return MP3_MIME;
  }
  return "application/octet-stream";
}

/** What the run that downloaded the file learnt about it; absent when an earlier attempt completed the unit. */
interface Downloaded {
  mimeType: string;
  height?: number;
  acquisition?: "guest" | "authenticated";
}

/**
 * The `cache_media` stage (client only): downloads a platform Content into a
 * `platform_cache` asset named and identified by what the request froze at submission.
 * `resultJson` = `{ assetId, fileName, requestedType, actualType, evicted,
 * reasons? }`; `reasons: ["audio_only"]` when a video was asked for but the platform
 * offers no picture.
 *
 * - Video: the adapter first reports what it would download; no video stream turns the
 *   request into an audio cache, otherwise the container decides the extension and the
 *   download must deliver that container. yt-dlp's intermediate files stay in the cache
 *   directory's `.amber-tmp/<assetId>/`, removed when the download ends.
 * - Audio: the best audio track is downloaded into the data directory and transcoded to
 *   MP3 (`CACHE_AUDIO_MP3_KBPS`) straight into the cache directory, after the disk budget
 *   of both volumes is checked against the announced sizes.
 *
 * The work is one file-backed WorkUnit under the heavy semaphore. A registered cache never
 * exceeds `CACHE_MEDIA_MAX_GB`. A new cache replaces the Content's older caches of the
 * same type only (marked `evicted` in the registering transaction, their files removed
 * after it on a best-effort basis); then the owner's total is brought back under the
 * limit. A custom cache root that is not mounted fails with `conflict.cache_unavailable`
 * before anything is downloaded. A request from before named cache files (schema v1)
 * fails with `invalid_request.cache_request_outdated`.
 */
export class CacheMediaStageExecutor implements StageExecutor {
  private readonly deps: CacheMediaStageDeps;
  private readonly now: () => number;

  constructor(deps: CacheMediaStageDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  async run(context: StageExecutionContext): Promise<StageOutcome> {
    const { task } = context;
    const owner = task.userId;
    const parsed = cacheMediaTaskRequestSchema.parse(context.request);
    if (parsed.requestSchemaVersion === 1) {
      throw amberError("invalid_request", "this cache request predates named cache files", { code: "invalid_request.cache_request_outdated" });
    }
    const request = parsed;
    const content = taskContent(this.deps.repository, context);
    const contentId = content.id;
    const target = platformTarget(this.deps.platforms, content);
    if (target === undefined) {
      throw amberError("invalid_request", "only platform contents have media to cache", { params: { detail: "contentId" } });
    }
    const files = this.deps.media.cache;
    if (!(await files.isAvailable())) {
      throw amberError("conflict", "the video cache root is not available", { code: "conflict.cache_unavailable" });
    }
    const maxBytes = this.deps.maxBytes ?? CACHE_MEDIA_MAX_GB * BYTES_PER_GB;
    let downloaded: Downloaded | undefined;
    const output = await context.runUnit({
      key: DOWNLOAD_UNIT_KEY,
      inputDigest: inputDigestOf(target, contentId, request),
      storage: "file",
      store: "cache",
      run: (signal) =>
        context.withHeavySlot(async () => {
          const progress = monotonic((value) => context.reportProgress(value));
          const job: CacheJob = { content, target, request, maxBytes, progress, signal };
          const result = request.type === "video" ? await this.cacheVideo(job) : undefined;
          const done = result ?? (await this.cacheAudio(job));
          downloaded = done.downloaded;
          return { outputRef: done.outputRef, outputDigest: done.outputDigest };
        }),
    });

    const ref = output.outputRef;
    const sizeBytes = (await files.stat(ref))?.sizeBytes ?? 0;
    const mimeType = downloaded?.mimeType ?? (await sniffMime(files, ref));
    const actualType: CacheMediaType = mimeType.startsWith("audio/") ? "audio" : "video";
    const sameType = actualType === "video" ? isVideoCache : isAudioCache;
    const fileName = cacheFileNameOf(ref);
    const { asset, replaced } = this.deps.repository.withTransaction((scope) => {
      const existing = scope.mediaAssets.listByContent(owner, contentId);
      const registered =
        existing.find((candidate) => candidate.id === request.assetId) ??
        ((): MediaAsset => {
          const created: MediaAsset = {
            id: request.assetId,
            userId: owner,
            contentId,
            kind: "platform_cache",
            storageRef: ref,
            displayName: fileName,
            mimeType,
            sizeBytes,
            ...(actualType === "video" ? { quality: String(downloaded?.height ?? request.quality ?? "") } : {}),
            fingerprint: output.outputDigest,
            ...(downloaded?.acquisition === undefined ? {} : { acquisition: downloaded.acquisition }),
            availability: "available",
            retentionPolicy: "evictable",
            createdAt: this.now(),
          };
          scope.mediaAssets.insert(created);
          return created;
        })();
      const older = existing.filter((candidate) => sameType(candidate) && candidate.availability === "available" && candidate.id !== registered.id);
      for (const stale of older) {
        scope.mediaAssets.update(owner, { ...stale, availability: "evicted" });
      }
      return { asset: registered, replaced: older };
    });
    for (const stale of replaced) {
      // A file the user holds open stays behind; the start-up sweep removes files whose rows are all evicted.
      try {
        await files.remove(stale.storageRef);
      } catch (error) {
        this.deps.logger?.warn("cache_replaced_file_kept", { assetId: stale.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const evicted = await this.deps.evict(owner, asset.id);
    return {
      resultJson: {
        assetId: asset.id,
        fileName,
        requestedType: request.type,
        actualType,
        evicted: [...replaced.map((stale) => stale.id), ...evicted],
        ...(request.type === "video" && actualType === "audio" ? { reasons: ["audio_only"] } : {}),
      },
    };
  }

  /** The video download, or `undefined` when the platform offers no picture and the audio path takes over. */
  private async cacheVideo(job: CacheJob): Promise<UnitOutput | undefined> {
    const { adapter, auth, ref: platformRef } = job.target;
    if (typeof adapter.inspectVideo !== "function" || typeof adapter.fetchVideo !== "function") {
      throw amberError("internal", `the ${adapter.kind} adapter cannot download video`);
    }
    const maxHeight = job.request.quality as number;
    const inspected = await adapter.inspectVideo(platformRef, auth, { maxHeight }, job.signal);
    if (!inspected.hasVideo) {
      return undefined;
    }
    if (inspected.sizeBytes !== undefined && inspected.sizeBytes > job.maxBytes) {
      throw tooLarge(job.maxBytes);
    }
    const ext = cacheExtensionOf(inspected.mimeType);
    if (ext === undefined || ext === "mp3") {
      throw amberError("internal", `the adapter announced ${inspected.mimeType} for a video`, { code: "internal.tool_failed" });
    }
    const ref = cacheRef(job.request.fileName, ext);
    await this.assertNameFree(ref, job.request.assetId);
    let downloaded: Downloaded | undefined;
    // On the cache directory's volume, so the merged file reaches its partial by a rename.
    const scratch = await this.deps.media.cache.openScratch(job.request.assetId);
    try {
      const stored = await this.writeCache(
        ref,
        async (partial) => {
          const fetched = await adapter.fetchVideo?.(
            platformRef,
            auth,
            { maxHeight, maxBytes: job.maxBytes, output: { path: partial, scratchDir: scratch.path } },
            job.progress,
            job.signal,
          );
          if (fetched === undefined || fetched.mimeType !== inspected.mimeType) {
            throw amberError("internal", `announced ${inspected.mimeType}, downloaded ${fetched?.mimeType ?? "nothing"}`, { code: "internal.tool_failed" });
          }
          downloaded = { mimeType: fetched.mimeType, ...(fetched.height === undefined ? {} : { height: fetched.height }), acquisition: fetched.acquisition };
        },
        job.maxBytes,
      );
      return { outputRef: ref, outputDigest: stored.digest, ...(downloaded === undefined ? {} : { downloaded }) };
    } finally {
      // What stays behind goes with the next start-up sweep.
      await scratch.close().catch((error: unknown) => this.deps.logger?.warn("cache_scratch_remove_failed", { error: (error as NodeJS.ErrnoException | undefined)?.code ?? "error" }));
    }
  }

  /** The audio track downloaded into the data directory and transcoded to MP3 into the cache. */
  private async cacheAudio(job: CacheJob): Promise<UnitOutput> {
    const { adapter, auth, ref: platformRef } = job.target;
    if (typeof adapter.inspectAudio !== "function") {
      throw amberError("internal", `the ${adapter.kind} adapter cannot inspect audio`);
    }
    const announced = (await adapter.inspectAudio(platformRef, auth, job.signal)).sizeBytes ?? 0;
    if (announced > job.maxBytes) {
      throw tooLarge(job.maxBytes);
    }
    await this.checkAudioBudget(job.content, announced);
    const ref = cacheRef(job.request.fileName, "mp3");
    await this.assertNameFree(ref, job.request.assetId);

    const data = this.deps.media.data;
    const scratchRef = `${AUDIO_SCRATCH_DIR}/${job.request.assetId}`;
    try {
      try {
        await data.writeAtomic(
          scratchRef,
          async (partial) => {
            await adapter.fetchAudio(platformRef, auth, { path: partial }, (value) => job.progress(value * AUDIO_DOWNLOAD_PROGRESS_SHARE), job.signal, {
              maxBytes: job.maxBytes,
            });
          },
          { maxBytes: job.maxBytes },
        );
      } catch (error) {
        throw error instanceof FileTooLargeError ? tooLarge(job.maxBytes) : error;
      }
      job.progress(AUDIO_DOWNLOAD_PROGRESS_SHARE);
      const stored = await this.writeCache(
        ref,
        async (partial) => {
          await this.deps.ingest.transcodeAudio(
            { path: data.pathOf(scratchRef) },
            { path: partial },
            { bitrateKbps: CACHE_AUDIO_MP3_KBPS },
            (value) => job.progress(AUDIO_DOWNLOAD_PROGRESS_SHARE + value * (1 - AUDIO_DOWNLOAD_PROGRESS_SHARE)),
            job.signal,
          );
        },
        job.maxBytes,
      );
      return { outputRef: ref, outputDigest: stored.digest, downloaded: { mimeType: MP3_MIME } };
    } finally {
      await data.remove(scratchRef).catch(() => undefined);
    }
  }

  /**
   * The audio budget: the data volume must stay above the low-water mark
   * with the downloaded track on it, the cache volume with the MP3 on it (and the track as
   * well when both are one volume). The MP3 is estimated from the Content's duration; an
   * unknown duration counts as zero and leaves the margin to the low-water mark itself.
   */
  private async checkAudioBudget(content: Content, sourceBytes: number): Promise<void> {
    const mp3Bytes = Math.ceil((((content.durationMs ?? 0) / 1000) * CACHE_AUDIO_MP3_KBPS * 1000 * MP3_SIZE_MARGIN) / 8);
    const settings = this.deps.settings.effective();
    const [data, cache, sameVolume] = await Promise.all([this.deps.media.data.diskUsage(), this.deps.media.cache.diskUsage(), this.deps.sameVolume()]);
    const dataLow = belowWatermark({ ...data, freeBytes: data.freeBytes - sourceBytes }, settings);
    const cacheLow = belowWatermark({ ...cache, freeBytes: cache.freeBytes - mp3Bytes - (sameVolume ? sourceBytes : 0) }, settings);
    if (dataLow || cacheLow) {
      throw amberError("disk_low", "not enough room for the audio track and its MP3");
    }
  }

  /**
   * A retried or reopened Task writes the name frozen when it was submitted; by now another
   * cache, a purged cache still waiting to be removed, or a file the user put in the cache
   * directory may hold it. None is ever overwritten: the Task fails and caching again picks
   * a free name.
   */
  private async assertNameFree(ref: string, assetId: string): Promise<void> {
    const name = foldCase(cacheFileNameOf(ref));
    const heldByRow = this.deps.repository
      .withTransaction((scope) => scope.mediaAssets.listAvailableCachesUnscoped())
      .some((asset) => asset.id !== assetId && isCacheRef(asset.storageRef) && foldCase(cacheFileNameOf(asset.storageRef)) === name);
    const pending = [...(this.deps.pendingCacheRefs?.() ?? [])].some((pendingRef) => foldCase(cacheFileNameOf(pendingRef)) === name);
    if (heldByRow || pending || (await this.deps.media.cache.stat(ref)) !== null) {
      throw amberError("conflict", "the cache file name is taken by now");
    }
  }

  private async writeCache(ref: string, write: (partial: string) => Promise<void>, maxBytes: number) {
    try {
      return await this.deps.media.cache.writeAtomic(ref, write, { maxBytes });
    } catch (error) {
      throw error instanceof FileTooLargeError ? tooLarge(maxBytes) : error;
    }
  }
}

interface CacheJob {
  content: Content;
  target: PlatformTarget;
  request: CacheMediaTaskRequestV2;
  maxBytes: number;
  progress: (progress: number) => void;
  signal: AbortSignal;
}

interface UnitOutput {
  outputRef: string;
  outputDigest: string;
  downloaded?: Downloaded;
}

/** Everything that decides the cache file: source, what was asked for, and the frozen name and asset id. */
function inputDigestOf(target: PlatformTarget, contentId: string, request: CacheMediaTaskRequestV2): string {
  const fields = [target.adapter.kind, target.ref.platformContentId, target.ref.platformPartId ?? "", contentId, request.type, request.quality ?? "", request.fileName, request.assetId];
  return `sha256:${createHash("sha256").update(JSON.stringify(fields), "utf8").digest("hex")}`;
}
