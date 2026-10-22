import type { ModelRef } from "../domain/model-ref.ts";
import { ASR_SUBMIT_UNIT_KEY } from "../../shared/work-steps.ts";
import type { StageRun, Task } from "../domain/task.ts";
import { parseStageInput, taskRequestView } from "../domain/task-request.ts";
import { isTerminalStage, latestAttempts } from "../pipeline/projection.ts";
import type { RepositoryScope } from "../ports/repository.ts";

/**
 * Unfinished Tasks of the owner that use the profile (or, with `modelId`, that model of
 * it) through their request or a frozen stage input. A profile or model in use cannot be
 * deleted: the Task would fail half-way for a reason the user just caused.
 */
export function unfinishedTasksUsingModel(scope: RepositoryScope, ownerUserId: string, providerProfileId: string, modelId?: string): Task[] {
  const names = (ref: ModelRef | undefined): boolean =>
    ref !== undefined && ref.providerProfileId === providerProfileId && (modelId === undefined || ref.modelId === modelId);
  return scope.tasks
    .listUnfinishedOf(ownerUserId)
    .filter(
      (task) =>
        names(taskRequestView(task.requestJson).modelRef) ||
        scope.stageRuns.listByTask(ownerUserId, task.id).some((run) => names(parseStageInput(run.inputJson).modelRef)),
    );
}

/**
 * Unfinished Tasks of the owner whose ASR stage, in its latest attempt, has not ended
 * (queued ones included: every stage run exists from submission) and is bound to the
 * profile, or with `modelId` to that model of it (frozen stage input first, then the Task
 * request). Such a Task still needs the binding as it is: the model cannot be removed, the
 * endpoint cannot change and the profile cannot be deleted.
 */
export function unfinishedTasksUsingAsrModel(scope: RepositoryScope, ownerUserId: string, asrProfileId: string, modelId?: string): Task[] {
  return boundAsrRuns(scope, ownerUserId, asrProfileId, modelId).map(({ task }) => task);
}

/**
 * Unfinished Tasks bound to the profile whose latest ASR attempt has already submitted a
 * remote job that has not yet been fetched. Such a job belongs to the account of the key
 * that submitted it, so the key cannot be replaced meanwhile.
 */
export function tasksAwaitingAsrJob(scope: RepositoryScope, ownerUserId: string, asrProfileId: string): Task[] {
  return boundAsrRuns(scope, ownerUserId, asrProfileId).flatMap(({ task, run }) =>
    scope.workUnits
      .listByTask(ownerUserId, task.id)
      .some((unit) => unit.stageRunId === run.id && unit.key === ASR_SUBMIT_UNIT_KEY && unit.status === "succeeded")
      ? [task]
      : [],
  );
}

function boundAsrRuns(scope: RepositoryScope, ownerUserId: string, asrProfileId: string, modelId?: string): Array<{ task: Task; run: StageRun }> {
  return scope.tasks.listUnfinishedOf(ownerUserId).flatMap((task) => {
    const run = latestAttempts(scope.stageRuns.listByTask(ownerUserId, task.id)).find((candidate) => candidate.stage === "asr");
    if (run === undefined || isTerminalStage(run.status)) {
      return [];
    }
    const ref = parseStageInput(run.inputJson).asrModelRef ?? taskRequestView(task.requestJson).asrModelRef;
    return ref !== undefined && ref.asrProfileId === asrProfileId && (modelId === undefined || ref.modelId === modelId) ? [{ task, run }] : [];
  });
}
