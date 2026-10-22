import type { AppError } from "../../../../shared/errors.ts";
import type { WorkUnit, WorkUnitResult } from "../../../domain/task.ts";
import type { WorkUnitRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { jsonOrNull, notFound, nullable, parseJsonOrNull, withoutNulls } from "./rows.ts";

interface WorkUnitRow {
  id: string;
  stage_run_id: string;
  unit_key: string;
  status: WorkUnit["status"];
  attempt: number;
  retry_count: number;
  retry_not_before: number | null;
  input_digest: string;
  output_ref: string | null;
  output_digest: string | null;
  error_json: string | null;
  billing: "none" | NonNullable<WorkUnit["billing"]>;
}

interface WorkUnitResultRow {
  work_unit_id: string;
  payload_json: string;
  output_digest: string;
  created_at: number;
}

function toWorkUnit(row: WorkUnitRow): WorkUnit {
  return withoutNulls<WorkUnit>({
    id: row.id,
    stageRunId: row.stage_run_id,
    key: row.unit_key,
    status: row.status,
    attempt: row.attempt,
    retryCount: row.retry_count,
    retryNotBefore: row.retry_not_before,
    inputDigest: row.input_digest,
    outputRef: row.output_ref,
    outputDigest: row.output_digest,
    error: parseJsonOrNull<AppError>(row.error_json),
    billing: row.billing === "none" ? null : row.billing,
  });
}

const OWNED_UNIT = `JOIN stage_run ON stage_run.id = work_unit.stage_run_id JOIN task ON task.id = stage_run.task_id`;

/** WorkUnits reach their owner through StageRun and Task. */
export function sqliteWorkUnitRepository(db: SqliteConnection): WorkUnitRepository {
  const select = db.prepare(`SELECT work_unit.* FROM work_unit ${OWNED_UNIT} WHERE work_unit.id = ? AND task.user_id = ?`);
  const byStageRun = db.prepare(
    `SELECT work_unit.* FROM work_unit ${OWNED_UNIT}
     WHERE work_unit.stage_run_id = ? AND task.user_id = ? ORDER BY work_unit.rowid`,
  );
  const byTask = db.prepare(
    `SELECT work_unit.* FROM work_unit ${OWNED_UNIT}
     WHERE stage_run.task_id = ? AND task.user_id = ? ORDER BY work_unit.rowid`,
  );
  const ownedStageRun = db.prepare(
    "SELECT 1 FROM stage_run JOIN task ON task.id = stage_run.task_id WHERE stage_run.id = ? AND task.user_id = ?",
  );
  const insert = db.prepare(
    `INSERT INTO work_unit (
       id, stage_run_id, unit_key, status, attempt, retry_count, retry_not_before, input_digest, output_ref, output_digest, error_json, billing
     ) VALUES (
       @id, @stageRunId, @key, @status, @attempt, @retryCount, @retryNotBefore, @inputDigest, @outputRef, @outputDigest, @errorJson, @billing
     )`,
  );
  const update = db.prepare(
    `UPDATE work_unit SET status = @status, attempt = @attempt, retry_count = @retryCount, retry_not_before = @retryNotBefore,
       input_digest = @inputDigest, output_ref = @outputRef,
       output_digest = @outputDigest, error_json = @errorJson, billing = @billing
     WHERE id = @id`,
  );
  const selectResult = db.prepare(
    `SELECT work_unit_result.* FROM work_unit_result JOIN work_unit ON work_unit.id = work_unit_result.work_unit_id ${OWNED_UNIT}
     WHERE work_unit_result.work_unit_id = ? AND task.user_id = ?`,
  );
  const putResult = db.prepare(
    `INSERT INTO work_unit_result (work_unit_id, payload_json, output_digest, created_at)
     VALUES (@workUnitId, @payloadJson, @outputDigest, @createdAt)
     ON CONFLICT (work_unit_id) DO UPDATE SET
       payload_json = excluded.payload_json, output_digest = excluded.output_digest, created_at = excluded.created_at`,
  );

  const requireUnit = (ownerUserId: string, workUnitId: string): void => {
    if (select.get(workUnitId, ownerUserId) === undefined) {
      throw notFound("work unit", workUnitId);
    }
  };

  return {
    get(ownerUserId, workUnitId) {
      const row = select.get(workUnitId, ownerUserId) as WorkUnitRow | undefined;
      return row === undefined ? undefined : toWorkUnit(row);
    },
    listByStageRun(ownerUserId, stageRunId) {
      return (byStageRun.all(stageRunId, ownerUserId) as WorkUnitRow[]).map(toWorkUnit);
    },
    listByTask(ownerUserId, taskId) {
      return (byTask.all(taskId, ownerUserId) as WorkUnitRow[]).map(toWorkUnit);
    },
    insert(ownerUserId, unit) {
      if (ownedStageRun.get(unit.stageRunId, ownerUserId) === undefined) {
        throw notFound("stage run", unit.stageRunId);
      }
      insert.run(unitParams(unit));
    },
    update(ownerUserId, unit) {
      requireUnit(ownerUserId, unit.id);
      update.run(unitParams(unit));
    },
    getResult(ownerUserId, workUnitId) {
      const row = selectResult.get(workUnitId, ownerUserId) as WorkUnitResultRow | undefined;
      return row === undefined
        ? undefined
        : { workUnitId: row.work_unit_id, payloadJson: row.payload_json, outputDigest: row.output_digest, createdAt: row.created_at };
    },
    putResult(ownerUserId, result: WorkUnitResult) {
      requireUnit(ownerUserId, result.workUnitId);
      putResult.run({ ...result });
    },
  };
}

function unitParams(unit: WorkUnit): Record<string, unknown> {
  return {
    id: unit.id,
    stageRunId: unit.stageRunId,
    key: unit.key,
    status: unit.status,
    attempt: unit.attempt,
    retryCount: unit.retryCount,
    retryNotBefore: nullable(unit.retryNotBefore),
    inputDigest: unit.inputDigest,
    outputRef: nullable(unit.outputRef),
    outputDigest: nullable(unit.outputDigest),
    errorJson: jsonOrNull(unit.error),
    billing: unit.billing ?? "none",
  };
}
