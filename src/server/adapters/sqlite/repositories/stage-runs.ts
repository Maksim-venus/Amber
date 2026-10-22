import type { AppError } from "../../../../shared/errors.ts";
import type { StageRun } from "../../../domain/task.ts";
import type { StageRunRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { jsonOrNull, notFound, nullable, parseJson, parseJsonOrNull, withoutNulls } from "./rows.ts";

interface StageRunRow {
  id: string;
  task_id: string;
  stage: StageRun["stage"];
  attempt: number;
  status: StageRun["status"];
  progress: number;
  dependencies_json: string;
  condition_id: NonNullable<StageRun["condition"]> | null;
  error_json: string | null;
  result_json: string | null;
  input_json: string | null;
  started_at: number | null;
  finished_at: number | null;
}

function toStageRun(row: StageRunRow): StageRun {
  return withoutNulls<StageRun>({
    id: row.id,
    taskId: row.task_id,
    stage: row.stage,
    attempt: row.attempt,
    status: row.status,
    progress: row.progress,
    dependencies: parseJson<StageRun["dependencies"]>(row.dependencies_json),
    condition: row.condition_id,
    error: parseJsonOrNull<AppError>(row.error_json),
    resultJson: row.result_json,
    inputJson: row.input_json,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  });
}

/** StageRuns carry no owner column; every statement reaches the owner through their Task. */
export function sqliteStageRunRepository(db: SqliteConnection): StageRunRepository {
  const listByTask = db.prepare(
    `SELECT stage_run.* FROM stage_run JOIN task ON task.id = stage_run.task_id
     WHERE stage_run.task_id = ? AND task.user_id = ? ORDER BY stage_run.rowid`,
  );
  const ownedTask = db.prepare("SELECT 1 FROM task WHERE id = ? AND user_id = ?");
  const insert = db.prepare(
    `INSERT INTO stage_run (
       id, task_id, stage, attempt, status, progress, dependencies_json, condition_id,
       error_json, result_json, input_json, started_at, finished_at
     ) VALUES (
       @id, @taskId, @stage, @attempt, @status, @progress, @dependenciesJson, @conditionId,
       @errorJson, @resultJson, @inputJson, @startedAt, @finishedAt
     )`,
  );
  const storedInput = db.prepare(
    `SELECT stage_run.input_json AS input_json FROM stage_run JOIN task ON task.id = stage_run.task_id
     WHERE stage_run.id = ? AND task.user_id = ?`,
  );
  const update = db.prepare(
    `UPDATE stage_run SET status = @status, progress = @progress, error_json = @errorJson, result_json = @resultJson,
       started_at = @startedAt, finished_at = @finishedAt
     WHERE id = @id`,
  );
  // Separate statement: naming input_json in an UPDATE fires its immutability trigger.
  const setInput = db.prepare("UPDATE stage_run SET input_json = ? WHERE id = ? AND input_json IS NULL");

  return {
    listByTask(ownerUserId, taskId) {
      return (listByTask.all(taskId, ownerUserId) as StageRunRow[]).map(toStageRun);
    },
    insert(ownerUserId, run) {
      if (ownedTask.get(run.taskId, ownerUserId) === undefined) {
        throw notFound("task", run.taskId);
      }
      insert.run({
        id: run.id,
        taskId: run.taskId,
        stage: run.stage,
        attempt: run.attempt,
        status: run.status,
        progress: run.progress,
        dependenciesJson: JSON.stringify(run.dependencies),
        conditionId: nullable(run.condition),
        errorJson: jsonOrNull(run.error),
        resultJson: nullable(run.resultJson),
        inputJson: nullable(run.inputJson),
        startedAt: nullable(run.startedAt),
        finishedAt: nullable(run.finishedAt),
      });
    },
    update(ownerUserId, run) {
      const stored = storedInput.get(run.id, ownerUserId) as { input_json: string | null } | undefined;
      if (stored === undefined) {
        throw notFound("stage run", run.id);
      }
      if (stored.input_json !== null && run.inputJson !== stored.input_json) {
        throw new TypeError("stage_run.input_json is immutable");
      }
      update.run({
        id: run.id,
        status: run.status,
        progress: run.progress,
        errorJson: jsonOrNull(run.error),
        resultJson: nullable(run.resultJson),
        startedAt: nullable(run.startedAt),
        finishedAt: nullable(run.finishedAt),
      });
      if (stored.input_json === null && run.inputJson !== undefined) {
        setInput.run(run.inputJson, run.id);
      }
    },
  };
}
