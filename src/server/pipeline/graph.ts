import type { StageConditionId, StageId, StageRequirementId, TaskKind } from "../../shared/enums.ts";
import type { ContentSourceKind } from "../domain/platform.ts";
import { isPlatform } from "../domain/platform.ts";

/**
 * One node of a Task's stage graph. `condition` false means `skipped`;
 * an unmet `requirement` means `waiting_configuration`. Requirements and the heavy flag
 * live only here and are never persisted on a StageRun: the graph is rebuilt from
 * `Task.kind` and the Content's source kind whenever it is needed.
 */
export interface StageSpec {
  stage: StageId;
  dependencies: StageId[];
  condition?: StageConditionId;
  requirement?: StageRequirementId;
  /** Runs the whole stage under the heavy-job semaphore (probing, cache download, burn-in). */
  heavy?: true;
}

const chain = (specs: Array<Omit<StageSpec, "dependencies">>): StageSpec[] =>
  specs.map((spec, index) => {
    const previous = specs[index - 1];
    return { ...spec, dependencies: previous === undefined ? [] : [previous.stage] };
  });

const downstreamOfTranscript: Array<Omit<StageSpec, "dependencies">> = [
  { stage: "asr", condition: "needs_asr", requirement: "asr_configured" },
  { stage: "proofread", condition: "auto_proofread_enabled", requirement: "llm_configured" },
  { stage: "chapter", condition: "no_platform_chapters", requirement: "llm_configured" },
  { stage: "summary", requirement: "llm_configured" },
];

/**
 * The StageRuns each Task.kind creates. `sourceKind` is the target Content's
 * source kind; Collection targets pass `undefined`.
 */
export function stageGraph(kind: TaskKind, sourceKind: ContentSourceKind | undefined): StageSpec[] {
  switch (kind) {
    case "process_content":
      if (sourceKind === undefined) {
        throw new TypeError("process_content needs a Content target");
      }
      return isPlatform(sourceKind)
        ? chain([{ stage: "source" }, { stage: "subtitle" }, ...downstreamOfTranscript])
        : chain([{ stage: "media", heavy: true }, ...downstreamOfTranscript]);
    case "retranscribe":
      return [{ stage: "asr", dependencies: [], requirement: "asr_configured" }];
    case "reproofread":
      return [{ stage: "proofread", dependencies: [], requirement: "llm_configured" }];
    case "regenerate_chapters":
      return [{ stage: "chapter", dependencies: [], requirement: "llm_configured" }];
    case "regenerate_summary":
      return [{ stage: "summary", dependencies: [], requirement: "llm_configured" }];
    case "recompute_highlights":
      return [{ stage: "highlight", dependencies: [], requirement: "llm_configured" }];
    case "translate":
      return [{ stage: "translate", dependencies: [], requirement: "llm_configured" }];
    case "summarize_collection":
      return [{ stage: "collection_summary", dependencies: [], requirement: "llm_configured" }];
    case "cache_media":
      return [{ stage: "cache_media", dependencies: [], condition: "client_only", heavy: true }];
    case "burn":
      return [{ stage: "burn", dependencies: [], condition: "client_only", heavy: true }];
  }
}

export function stageSpec(graph: readonly StageSpec[], stage: StageId): StageSpec | undefined {
  return graph.find((spec) => spec.stage === stage);
}

/** Stages that depend on `stage` directly or transitively, in graph order. */
export function downstreamStages(graph: readonly StageSpec[], stage: StageId): StageId[] {
  const reached = new Set<StageId>([stage]);
  const result: StageId[] = [];
  for (const spec of graph) {
    if (spec.dependencies.some((dependency) => reached.has(dependency))) {
      reached.add(spec.stage);
      result.push(spec.stage);
    }
  }
  return result;
}
