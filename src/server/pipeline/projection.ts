import type { ProcessingStatus, StageStatus } from "../../shared/enums.ts";
import { workStepOf, type WorkStep } from "../../shared/work-steps.ts";
import type { StageRun, WorkUnit } from "../domain/task.ts";

const TERMINAL_STAGE_STATUSES: ReadonlySet<StageStatus> = new Set(["succeeded", "failed", "skipped", "cancelled"]);
const TERMINAL_PROJECTIONS: ReadonlySet<ProcessingStatus> = new Set(["succeeded", "failed", "cancelled"]);

export function isTerminalStage(status: StageStatus): boolean {
  return TERMINAL_STAGE_STATUSES.has(status);
}

export function isTerminalProjection(status: ProcessingStatus): boolean {
  return TERMINAL_PROJECTIONS.has(status);
}

/** The latest attempt of each stage, in the order the stages first appear. */
export function latestAttempts(runs: readonly StageRun[]): StageRun[] {
  const latest = new Map<string, StageRun>();
  for (const run of runs) {
    const current = latest.get(run.stage);
    if (current === undefined || run.attempt > current.attempt) {
      latest.set(run.stage, run);
    }
  }
  return [...latest.values()];
}

/**
 * When a stage that only waits for its units' retry times may run again: the latest
 * `retryNotBefore` of its pending units, for a started (`running`, or `interrupted` after a
 * restart) stage none of whose units runs or waits for the user. `undefined` when the stage
 * does not wait that way.
 */
export function stageRetryTime(run: StageRun, units: readonly WorkUnit[]): number | undefined {
  if (run.status !== "running" && run.status !== "interrupted") {
    return undefined;
  }
  let latest: number | undefined;
  for (const unit of units) {
    if (unit.stageRunId !== run.id) {
      continue;
    }
    if (unit.status === "running" || unit.status === "waiting_user_action") {
      return undefined;
    }
    if (unit.status === "pending" && unit.retryNotBefore !== undefined && (latest === undefined || unit.retryNotBefore > latest)) {
      latest = unit.retryNotBefore;
    }
  }
  return latest;
}

/**
 * The time a Task that only waits for retry times shows (`TaskDto.retryNotBefore`): the
 * latest over its waiting stages; `undefined` when none waits that way. Whether that time
 * has passed is for the reader to judge, so the projection stays a function of state.
 */
export function taskRetryNotBefore(runs: readonly StageRun[], units: readonly WorkUnit[]): number | undefined {
  return taskWait(runs, units).retryNotBefore;
}

/** What a queued Task waits for (`TaskDto.retryNotBefore / waitingStep`). */
export interface TaskWait {
  retryNotBefore?: number;
  waitingStep?: WorkStep;
}

/**
 * `taskRetryNotBefore` with the named step of the unit that sets that time, when it names
 * one: the UI tells waiting for an ASR job's result apart from waiting for a model service.
 */
export function taskWait(runs: readonly StageRun[], units: readonly WorkUnit[]): TaskWait {
  let latest: number | undefined;
  let stage: StageRun | undefined;
  for (const run of latestAttempts(runs)) {
    const at = stageRetryTime(run, units);
    if (at !== undefined && (latest === undefined || at > latest)) {
      latest = at;
      stage = run;
    }
  }
  if (latest === undefined || stage === undefined) {
    return {};
  }
  const unit = units.find((candidate) => candidate.stageRunId === stage.id && candidate.status === "pending" && candidate.retryNotBefore === latest);
  const step = unit === undefined ? undefined : workStepOf(unit.key);
  return { retryNotBefore: latest, ...(step === undefined ? {} : { waitingStep: step }) };
}

/**
 * `Task.statusProjection` / `Content.processingStatus` from authoritative state, first
 * matching rule wins:
 * 1. work actually executing: a running WorkUnit, or a running StageRun none of whose
 *    units waits for the user or for its retry time → `running`;
 * 2. a WorkUnit `waiting_user_action` or a StageRun `waiting_configuration` → `waiting`;
 * 3. anything still schedulable (`pending` / `interrupted`), or a started stage that only
 *    waits for its units' retry times (it holds no Task slot) → `queued`;
 * 4. all terminal: any `cancelled` → `cancelled`, any `failed` → `failed`, else `succeeded`.
 * A paid call with unknown outcome keeps its StageRun `running` with the unit parked, so
 * rule 1 fails and rule 2 yields `waiting`.
 */
export function projectStatus(runs: readonly StageRun[], units: readonly WorkUnit[]): ProcessingStatus {
  const current = latestAttempts(runs);
  const currentIds = new Set(current.map((run) => run.id));
  const currentUnits = units.filter((unit) => currentIds.has(unit.stageRunId));
  const parked = new Set(currentUnits.filter((unit) => unit.status === "waiting_user_action").map((unit) => unit.stageRunId));
  const deferred = new Set(current.filter((run) => stageRetryTime(run, currentUnits) !== undefined).map((run) => run.id));

  if (
    currentUnits.some((unit) => unit.status === "running") ||
    current.some((run) => run.status === "running" && !parked.has(run.id) && !deferred.has(run.id))
  ) {
    return "running";
  }
  if (parked.size > 0 || current.some((run) => run.status === "waiting_configuration")) {
    return "waiting";
  }
  if (deferred.size > 0 || current.some((run) => run.status === "pending" || run.status === "interrupted")) {
    return "queued";
  }
  if (current.some((run) => run.status === "cancelled")) {
    return "cancelled";
  }
  if (current.some((run) => run.status === "failed")) {
    return "failed";
  }
  return "succeeded";
}
