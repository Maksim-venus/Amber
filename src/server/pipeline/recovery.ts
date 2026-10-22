import { appError } from "../domain/errors.ts";
import type { WorkUnitBilling } from "../domain/task.ts";
import type { Repository } from "../ports/repository.ts";
import type { TaskEventBus } from "./events.ts";
import { transact } from "./publish.ts";
import { loadTaskState, refreshProjection, saveStageRun, saveWorkUnit } from "./task-state.ts";

/** The unknown-outcome class a paid unit carries when the process died during its call. */
const OUTCOME_UNKNOWN: Record<WorkUnitBilling, "asr_timeout" | "llm_outcome_unknown"> = {
  asr: "asr_timeout",
  llm: "llm_outcome_unknown",
};

/**
 * Crash recovery at start-up: whatever was `running` when the process died is re-queued
 * within the same attempt as `interrupted`, except units making a paid call. Their outcome
 * is unknown, so they wait for the user's confirmation like any other unknown-outcome call
 * and their stage stays `running`. Invariant: a paid call whose outcome is unknown is never
 * re-sent automatically. An LLM unit still waiting for admission, or for its retry time, is `pending`, has nothing in flight
 * and is left to re-run with its stage, its `retryNotBefore` kept. Units already waiting for
 * the user stay parked, so a restart never re-sends a paid call.
 * Returns the number of rows changed.
 */
export function recoverInterrupted(repository: Repository, bus: TaskEventBus, now: number): number {
  return transact(repository, bus, (scope, outbox) => {
    let changed = 0;
    for (const task of scope.tasks.listUnfinished()) {
      const state = loadTaskState(scope, task.userId, task.id);
      if (state === undefined) {
        continue;
      }
      const parkedRuns = new Set<string>();
      for (const unit of state.units) {
        if (unit.status !== "running") {
          continue;
        }
        if (unit.billing === undefined) {
          saveWorkUnit(scope, outbox, task.userId, { ...unit, status: "interrupted" });
        } else {
          saveWorkUnit(scope, outbox, task.userId, { ...unit, status: "waiting_user_action", error: appError(OUTCOME_UNKNOWN[unit.billing]) });
          parkedRuns.add(unit.stageRunId);
        }
        changed += 1;
      }
      for (const run of state.runs) {
        if (run.status === "running" && !parkedRuns.has(run.id)) {
          saveStageRun(scope, outbox, task.userId, { ...run, status: "interrupted" });
          changed += 1;
        }
      }
      refreshProjection(scope, outbox, task.userId, task.id, now);
    }
    return changed;
  });
}
