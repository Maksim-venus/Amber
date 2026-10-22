import type { RunMode, StageConditionId, TranscriptKind } from "../../shared/enums.ts";
import type { Content } from "../domain/content.ts";
import { isPlatform, type ContentSourceKind } from "../domain/platform.ts";
import type { StageRun } from "../domain/task.ts";
import type { TaskRequestView } from "../domain/task-request.ts";
import type { RepositoryScope } from "../ports/repository.ts";
import { latestAttempts } from "./projection.ts";

/** What skip conditions are evaluated against, gathered when the stage is reached. */
export interface ConditionFacts {
  mode: RunMode;
  sourceKind: ContentSourceKind | undefined;
  request: TaskRequestView;
  primaryTranscriptKind: TranscriptKind | undefined;
  /** `verdict` from the latest subtitle StageRun's result, when there is one. */
  subtitleVerdict: string | undefined;
  hasPlatformChapters: boolean;
}

/** True means the stage runs; false means it is `skipped`. */
export function conditionHolds(condition: StageConditionId, facts: ConditionFacts): boolean {
  switch (condition) {
    case "needs_asr":
      // A user-imported primary transcript is never replaced by ASR.
      if (facts.primaryTranscriptKind === "imported") {
        return false;
      }
      return facts.sourceKind === undefined || !isPlatform(facts.sourceKind) || facts.subtitleVerdict !== "valid";
    case "auto_proofread_enabled":
      return facts.request.autoProofread === true;
    case "no_platform_chapters":
      return !facts.hasPlatformChapters;
    case "is_local_file":
      return facts.sourceKind !== undefined && !isPlatform(facts.sourceKind);
    case "client_only":
      return facts.mode === "local";
  }
}

export function gatherConditionFacts(
  scope: RepositoryScope,
  input: { mode: RunMode; content: Content | undefined; request: TaskRequestView; stageRuns: readonly StageRun[] },
): ConditionFacts {
  const { content } = input;
  const primary =
    content?.primaryTranscriptRevisionId === undefined
      ? undefined
      : scope.transcripts.getRevision(content.userId, content.primaryTranscriptRevisionId);
  const subtitle = latestAttempts(input.stageRuns).find((run) => run.stage === "subtitle");
  return {
    mode: input.mode,
    sourceKind: content?.source.kind,
    request: input.request,
    primaryTranscriptKind: primary?.kind,
    subtitleVerdict: resultVerdict(subtitle?.resultJson),
    hasPlatformChapters: content === undefined ? false : scope.chapters.hasPlatformChapters(content.userId, content.id),
  };
}

function resultVerdict(resultJson: string | undefined): string | undefined {
  if (resultJson === undefined) {
    return undefined;
  }
  const verdict = (JSON.parse(resultJson) as { verdict?: unknown }).verdict;
  return typeof verdict === "string" ? verdict : undefined;
}
