import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../../../src/server/adapters/sqlite/database.ts";
import { latestSchemaVersion, MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { insertRow, openTempDatabase, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;

function seedStageRun(db: ReturnType<typeof openTempDatabase>["db"]): void {
  insertRow(db, "user", { id: "u", role: "user", status: "active", created_at: T0 });
  insertRow(db, "content", { id: "c", user_id: "u", source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
  insertRow(db, "task", { id: "t", user_id: "u", content_id: "c", kind: "regenerate_summary", request_json: "{}", status_projection: "queued", created_at: T0 });
  insertRow(db, "stage_run", { id: "s", task_id: "t", stage: "summary", attempt: 1, status: "pending", progress: 0, dependencies_json: "[]" });
}

describe("migration 0003: runtime support", () => {
  it("keeps instance_settings to one row with structural ranges", () => {
    // The table as this migration created it; later migrations dropped two of its columns.
    const dir = tempDataDir();
    const { db } = openDatabase(join(dir, "amber.db"), { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 3) });
    const row = {
      id: 1, concurrency_heavy: 1, concurrency_pipeline: 2, concurrency_llm: 3, max_data_gb: 30, low_water_free_gb: 10,
      low_water_free_ratio: 0.2, upload_retention_default: "keep", updated_at: T0,
    };
    insertRow(db, "instance_settings", row);
    expect(() => insertRow(db, "instance_settings", { ...row, id: 2 })).toThrow(/CHECK/);
    db.prepare("DELETE FROM instance_settings").run();
    for (const invalid of [{ concurrency_llm: 0 }, { max_data_gb: 0 }, { low_water_free_ratio: 1.5 }]) {
      expect(() => insertRow(db, "instance_settings", { ...row, ...invalid })).toThrow(/CHECK/);
    }
  });

  it("makes (user, route, key) unique for idempotency records and cascades them with the user", () => {
    const { db } = openTempDatabase();
    insertRow(db, "user", { id: "u", role: "user", status: "active", created_at: T0 });
    const record = { user_id: "u", route: "POST /api/contents/import", idempotency_key: "k", request_digest: "d", response_status: 202, response_body_json: "{}", resource_refs_json: "[]", created_at: T0 };
    insertRow(db, "idempotency_record", record);
    expect(() => insertRow(db, "idempotency_record", record)).toThrow(/UNIQUE|PRIMARY KEY/);
    db.prepare("DELETE FROM user WHERE id = 'u'").run();
    expect(db.prepare("SELECT count(*) AS n FROM idempotency_record").get()).toEqual({ n: 0 });
  });

  it("lets StageRun.inputJson be written once and never changed", () => {
    const { db } = openTempDatabase();
    seedStageRun(db);
    expect(() => db.prepare("UPDATE stage_run SET input_json = 'not json' WHERE id = 's'").run()).toThrow(/CHECK/);
    db.prepare(`UPDATE stage_run SET input_json = '{"modelRef":{"providerProfileId":"p","modelId":"m"}}' WHERE id = 's'`).run();
    expect(() => db.prepare(`UPDATE stage_run SET input_json = '{}' WHERE id = 's'`).run()).toThrow(/immutable/);
    db.prepare("UPDATE stage_run SET status = 'running' WHERE id = 's'").run();
  });

  it("upgrades a version 2 database, keeping existing stage runs with no input", () => {
    const dir = tempDataDir();
    const file = join(dir, "amber.db");
    const { db: v2 } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 2) });
    seedStageRun(v2);
    v2.close();
    const { db, from, to, backupPath } = openDatabase(file, { backupDir: join(dir, "backups") });
    expect({ from, to }).toEqual({ from: 2, to: latestSchemaVersion() });
    expect(backupPath).toBeDefined();
    expect(db.prepare("SELECT id, input_json FROM stage_run").all()).toEqual([{ id: "s", input_json: null }]);
    db.close();
  });
});
