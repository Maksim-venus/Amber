import type { TranslationEntryDto, TranslationsDto } from "../../shared/dto/translation.ts";
import { amberError } from "../domain/errors.ts";
import { taskRequestView } from "../domain/task-request.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Repository } from "../ports/repository.ts";
import { isTerminalProjection } from "../pipeline/projection.ts";
import { transcriptRevisionDto } from "./contents.ts";

export interface TranslationServiceOptions {
  repository: Repository;
}

/**
 * Reading a Content's translations: one entry per target
 * language with its current `translated` revision and the history in that language. A
 * translation is stale when its parent is no longer the primary.
 */
export class TranslationService {
  private readonly options: TranslationServiceOptions;

  constructor(options: TranslationServiceOptions) {
    this.options = options;
  }

  get(principal: RequestPrincipal, contentId: string): TranslationsDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const content = scope.contents.get(owner, contentId);
      if (content === undefined) {
        throw amberError("not_found", "content not found");
      }
      const translated = scope.transcripts.listRevisions(owner, contentId).filter((revision) => revision.kind === "translated");
      const translations = scope.translations.listArtifacts(owner, contentId).map((artifact): TranslationEntryDto => {
        const current = translated.find((revision) => revision.id === artifact.currentRevisionId);
        const stale = current !== undefined && current.parentRevisionId !== content.primaryTranscriptRevisionId;
        return {
          artifactId: artifact.id,
          targetLanguage: artifact.targetLanguage,
          ...(current === undefined ? {} : { current: transcriptRevisionDto(current) }),
          revisions: translated.filter((revision) => revision.language === artifact.targetLanguage).map(transcriptRevisionDto),
          ...(stale ? { stale: true, staleReason: "transcript_changed" as const } : { stale: false }),
        };
      });
      const activeTasks = scope.tasks
        .listByContent(owner, contentId)
        .filter((task) => task.kind === "translate" && !isTerminalProjection(task.statusProjection))
        .map((task) => ({ taskId: task.id, targetLanguages: taskRequestView(task.requestJson).targetLanguages ?? [] }));
      return { translations, activeTasks };
    });
  }
}
