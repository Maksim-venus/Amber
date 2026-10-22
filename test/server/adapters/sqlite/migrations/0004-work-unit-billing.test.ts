import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, type SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { latestSchemaVersion, MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { insertRow, openTempDatabase, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;

function seedStageRun(db: SqliteConnection): void {
  insertRow(db, "user", { id: "u", role: "user", status: "active", created_at: T0 });
  insertRow(db, "content", { id: "c", user_id: "u", source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
  insertRow(db, "task", { id: "t", user_id: "u", content_id: "c", kind: "retranscribe", request_json: "{}", status_projection: "queued", created_at: T0 });
  insertRow(db, "stage_run", { id: "s", task_id: "t", stage: "asr", attempt: 1, status: "pending", progress: 0, dependencies_json: "[]" });
}

describe("migration 0004: work unit billing", () => {
  it("upgrades a version 3 database, giving existing units no billing", () => {
    const dir = tempDataDir();
    const file = join(dir, "amber.db");
    const { db: v3 } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 3) });
    seedStageRun(v3);
    insertRow(v3, "work_unit", { id: "w", stage_run_id: "s", unit_key: "media:extract_audio", status: "succeeded", attempt: 1, input_digest: "d" });
    v3.close();
    const { db, from, to } = openDatabase(file, { backupDir: join(dir, "backups") });
    expect({ from, to }).toEqual({ from: 3, to: latestSchemaVersion() });
    expect(db.prepare("SELECT id, billing FROM work_unit").all()).toEqual([{ id: "w", billing: "none" }]);
    db.close();
  });

  it("accepts only none, asr and llm", () => {
    const { db } = openTempDatabase();
    seedStageRun(db);
    const unit = { stage_run_id: "s", status: "pending", attempt: 1, input_digest: "d" };
    insertRow(db, "work_unit", { ...unit, id: "a", unit_key: "asr:submit", billing: "asr" });
    insertRow(db, "work_unit", { ...unit, id: "l", unit_key: "llm", billing: "llm" });
    expect(() => insertRow(db, "work_unit", { ...unit, id: "x", unit_key: "x", billing: "paid" })).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE work_unit SET billing = NULL WHERE id = 'a'").run()).toThrow(/NOT NULL/);
  });
});
