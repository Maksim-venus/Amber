import { monotonicFactory } from "ulid";
import { amberError } from "../../domain/errors.ts";
import { normalizePlatformChapters } from "../../domain/platform-subtitle.ts";
import type { Repository } from "../../ports/repository.ts";
import type { StageExecutionContext, StageExecutor, StageOutcome } from "../executor.ts";
import { platformTarget, taskContent, type PlatformAccess } from "./platform-access.ts";

export interface SourceStageDeps {
  repository: Repository;
  platforms: PlatformAccess;
  now?: () => number;
  newId?: () => string;
}

/**
 * The `source` stage of a platform `process_content`: fetches the
 * platform metadata, fills the Content's title, duration, cover, date and channel, and
 * stores creator chapters as a `ChapterRevision(origin = platform)` (first chapter from 0,
 * deduplicated by content). Platform chapters become current unless an AI revision
 * already is.
 */
export class SourceStageExecutor implements StageExecutor {
  private readonly deps: SourceStageDeps;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(deps: SourceStageDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? monotonicFactory();
  }

  async run(context: StageExecutionContext): Promise<StageOutcome> {
    const content = taskContent(this.deps.repository, context);
    const target = platformTarget(this.deps.platforms, content);
    if (target === undefined) {
      throw new TypeError("the source stage needs a platform Content");
    }
    // Metadata goes through the platform's extractor: managed heavy work that waits for a slot of
    // the shared heavy-job governor.
    const metadata = await context.withHeavySlot(() => target.adapter.fetchMetadata(target.ref, target.auth, context.signal));
    if (!(metadata.durationMs > 0)) {
      throw amberError("source_unreachable", "the platform reported no duration");
    }
    const chapters = normalizePlatformChapters(metadata.chapters ?? [], metadata.durationMs);
    const owner = content.userId;
    return {
      resultJson: { reasons: [] },
      publish: (scope) => {
        const now = this.now();
        scope.contents.setMetadata(
          owner,
          content.id,
          {
            title: metadata.title,
            durationMs: metadata.durationMs,
            ...(metadata.coverUrl === undefined ? {} : { coverUrl: metadata.coverUrl }),
            ...(metadata.publishedAt === undefined ? {} : { publishedAt: metadata.publishedAt }),
            ...(metadata.rawLanguage === undefined || content.rawLanguage !== undefined ? {} : { rawLanguage: metadata.rawLanguage }),
            ...(metadata.channelId === undefined ? {} : { channelId: metadata.channelId }),
            ...(metadata.channelTitle === undefined ? {} : { channelTitle: metadata.channelTitle }),
          },
          now,
        );
        scope.search.syncContent(owner, content.id);
        if (chapters.length === 0) {
          return;
        }
        const { revisionId } = scope.chapters.insertPlatformRevision(owner, content.id, {
          id: this.newId(),
          artifactId: this.newId(),
          chapters,
          createdAt: now,
        });
        const current = scope.chapters.getCurrent(owner, content.id);
        if (current === undefined || current.origin.kind === "platform") {
          scope.chapters.setCurrent(owner, content.id, revisionId);
        }
      },
    };
  }
}
