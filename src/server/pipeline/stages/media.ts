import { amberError, isAmberError } from "../../domain/errors.ts";
import type { MediaAsset } from "../../domain/media-asset.ts";
import type { FileStore } from "../../ports/file-store.ts";
import type { LocalMediaIngest } from "../../ports/local-media-ingest.ts";
import type { Repository } from "../../ports/repository.ts";
import type { RunMode } from "../../../shared/enums.ts";
import { importedSubtitleWarnings } from "../../domain/subtitle-verdict.ts";
import { processContentRequestSchema, taskRequestView } from "../../domain/task-request.ts";
import { conditionHolds, gatherConditionFacts } from "../conditions.ts";
import type { StageExecutionContext, StageExecutor, StageOutcome } from "../executor.ts";
import { assetPath, availableOriginal, markMissing, singleStore } from "./source-media.ts";

export interface MediaStageDeps {
  repository: Repository;
  files: Pick<FileStore, "pathOf">;
  ingest: LocalMediaIngest;
  mode: RunMode;
  now?: () => number;
}

function titleFrom(displayName: string | undefined): string | undefined {
  if (displayName === undefined) {
    return undefined;
  }
  const title = displayName.replace(/\.[^.]*$/, "").trim();
  return title === "" ? displayName : title;
}

/**
 * The `media` stage of a local `process_content`: probes the original
 * file only, checking that it is still the file that was imported. Audio is extracted
 * later by the stages that need it. A missing audio track fails the stage only when this
 * Task will run ASR; otherwise it is recorded as a reason and processing continues. The
 * timeline of a subtitle imported with the file is sanity-checked into reasons.
 */
export class MediaStageExecutor implements StageExecutor {
  private readonly deps: MediaStageDeps;
  private readonly now: () => number;

  constructor(deps: MediaStageDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  async run(context: StageExecutionContext): Promise<StageOutcome> {
    const { task } = context;
    const owner = task.userId;
    const contentId = task.contentId;
    if (contentId === undefined) {
      throw new TypeError("the media stage needs a Content target");
    }
    const asset = this.deps.repository.withTransaction((scope) => availableOriginal(scope, owner, contentId));
    if (asset === undefined) {
      throw amberError("media_missing", "no available original media for this content");
    }
    const probe = await this.probe(asset, context.signal);
    if (asset.fingerprint !== undefined && probe.fingerprint !== asset.fingerprint) {
      throw amberError("media_changed", "the file no longer matches the fingerprint recorded at import");
    }

    const reasons: string[] = [];
    if (!probe.hasAudio) {
      const needsAsr = this.deps.repository.withTransaction((scope) => {
        const content = scope.contents.getIncludingTrashed(owner, contentId);
        const facts = gatherConditionFacts(scope, {
          mode: this.deps.mode,
          content,
          request: taskRequestView(task.requestJson),
          stageRuns: scope.stageRuns.listByTask(owner, task.id),
        });
        return conditionHolds("needs_asr", facts);
      });
      if (needsAsr) {
        throw amberError("media_no_audio", "the file has no audio track and this task needs ASR");
      }
      reasons.push("media_no_audio");
    }

    // A subtitle imported with the file is checked against the probed duration; problems
    // are warnings only, never a reason to transcribe.
    const request = processContentRequestSchema.safeParse(JSON.parse(task.requestJson));
    const subtitleRevisionId = request.success ? request.data.initialSubtitleRevisionId : undefined;
    if (subtitleRevisionId !== undefined) {
      const segments = this.deps.repository.withTransaction((scope) => scope.transcripts.listSegments(owner, subtitleRevisionId));
      reasons.push(...importedSubtitleWarnings(segments, probe.durationMs));
    }

    return {
      resultJson: { reasons },
      publish: (scope) => {
        const now = this.now();
        const title = scope.contents.getIncludingTrashed(owner, contentId)?.title === undefined ? titleFrom(asset.displayName) : undefined;
        scope.contents.setMetadata(owner, contentId, { durationMs: probe.durationMs, ...(title === undefined ? {} : { title }) }, now);
        if (title !== undefined) {
          scope.search.syncContent(owner, contentId);
        }
        const current = scope.mediaAssets.get(owner, asset.id);
        if (current !== undefined) {
          scope.mediaAssets.update(owner, { ...current, durationMs: probe.durationMs, mimeType: probe.mimeType, fingerprint: probe.fingerprint });
        }
      },
    };
  }

  private async probe(asset: MediaAsset, signal: AbortSignal) {
    try {
      return await this.deps.ingest.probe(assetPath(asset, singleStore(this.deps.files)), signal);
    } catch (error) {
      if (isAmberError(error) && error.appError.class === "media_missing") {
        markMissing(this.deps.repository, asset);
      }
      throw error;
    }
  }
}
