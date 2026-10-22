import type { StageId } from "../../shared/enums.ts";
import type { Task } from "../domain/task.ts";
import { taskRequestView } from "../domain/task-request.ts";
import type { ContentSourceKind } from "../domain/platform.ts";
import { stageGraph } from "./graph.ts";

/**
 * The mutation lane a Task occupies on its target: its stage set, with summaries told apart
 * by template and translations by target language. On one target at most one unfinished
 * Task may hold lane keys that intersect another's; a second one is refused with `conflict`
 * until the first is cancelled or ends. This keeps two "regenerate summary" Tasks from
 * overwriting each other's `currentRevisionId`. An idempotency key only stops the same
 * request from being submitted twice and does not replace this rule. On one Content
 * `cache_media` and `burn` exclude each other and each runs alone: a cache Task also holds
 * the `burn` key, so replacing a cache never races a burn reading it. Neither touches any
 * other Task's lane.
 */
export function laneKeys(task: Pick<Task, "kind" | "requestJson">, sourceKind: ContentSourceKind | undefined): string[] {
  const request = taskRequestView(task.requestJson);
  return stageGraph(task.kind, sourceKind).flatMap((spec) => laneKeysOfStage(spec.stage, request));
}

function laneKeysOfStage(stage: StageId, request: ReturnType<typeof taskRequestView>): string[] {
  switch (stage) {
    case "summary":
      return [`summary:${request.templateRef?.id ?? ""}`];
    case "translate":
      return (request.targetLanguages ?? []).map((language) => `translate:${language}`);
    case "cache_media":
      return ["cache_media", "burn"];
    default:
      return [stage];
  }
}

/**
 * The unfinished Task on the same target whose lane intersects the candidate's, if any.
 * At most one may exist; the caller answers `conflict.mutation_lane`.
 */
export function laneConflict(
  candidateKeys: readonly string[],
  others: ReadonlyArray<{ task: Task; keys: readonly string[] }>,
): Task | undefined {
  const wanted = new Set(candidateKeys);
  return others.find(({ keys }) => keys.some((key) => wanted.has(key)))?.task;
}
