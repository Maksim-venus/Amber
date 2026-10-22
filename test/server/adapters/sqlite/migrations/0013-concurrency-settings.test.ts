import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, type SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { latestSchemaVersion, MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { isAmberError } from "../../../../../src/server/domain/errors.ts";
import { insertRow, openTempDatabase, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
const MARKER = JSON.stringify({ id: "m", from: "/data", to: "/mnt/Amber Cache", phase: "cleanup_pending" });

function columns(db: SqliteConnection, table: string): string[] {
  return (db.prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all() as Array<{ name: string }>).map((row) => row.name);
}

function seedStageRun(db: SqliteConnection): void {
  insertRow(db, "user", { id: "u", role: "user", status: "active", created_at: T0 });
  insertRow(db, "content", { id: "c", user_id: "u", source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
  insertRow(db, "task", { id: "t", user_id: "u", content_id: "c", kind: "regenerate_summary", request_json: "{}", status_projection: "queued", created_at: T0 });
  insertRow(db, "stage_run", { id: "s", task_id: "t", stage: "summary", attempt: 1, status: "pending", progress: 0, dependencies_json: "[]" });
}

describe("migration 0013: one concurrency setting and work unit retries", () => {
  it("drops the two removed settings, keeps the rest of the row and gives existing units no retries", () => {
    const dir = tempDataDir();
    const file = join(dir, "amber.db");
    const { db: v12 } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 12) });
    insertRow(v12, "instance_settings", {
      id: 1, concurrency_heavy: 4, concurrency_pipeline: 3, concurrency_llm: 6, max_data_gb: 70, low_water_free_gb: 8,
      low_water_free_ratio: 0.15, upload_retention_default: "discard_after_audio", credentials_reset_at: T0 + 1,
      cache_root: "/mnt/Amber Cache", cache_migration_json: MARKER, updated_at: T0 + 2,
    });
    seedStageRun(v12);
    insertRow(v12, "work_unit", { id: "w", stage_run_id: "s", unit_key: "summary:0", status: "failed", attempt: 2, input_digest: "d", billing: "llm" });
    v12.close();

    const { db, from, to } = openDatabase(file, { backupDir: join(dir, "backups") });
    expect({ from, to }).toEqual({ from: 12, to: latestSchemaVersion() });
    expect(columns(db, "instance_settings")).not.toEqual(expect.arrayContaining(["concurrency_heavy"]));
    expect(columns(db, "instance_settings")).not.toEqual(expect.arrayContaining(["concurrency_llm"]));
    expect(db.prepare("SELECT * FROM instance_settings").get()).toEqual({
      id: 1, concurrency_pipeline: 3, max_data_gb: 70, low_water_free_gb: 8, low_water_free_ratio: 0.15,
      upload_retention_default: "discard_after_audio", credentials_reset_at: T0 + 1, cache_root: "/mnt/Amber Cache",
      cache_migration_json: MARKER, updated_at: T0 + 2,
    });
    expect(db.prepare("SELECT id, status, attempt, billing, retry_count, retry_not_before FROM work_unit").all()).toEqual([
      { id: "w", status: "failed", attempt: 2, billing: "llm", retry_count: 0, retry_not_before: null },
    ]);
    // The constraints that stayed still hold.
    expect(() => db.prepare("UPDATE instance_settings SET concurrency_pipeline = 0").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE work_unit SET retry_count = -1").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE work_unit SET retry_count = NULL").run()).toThrow(/NOT NULL/);
    db.close();
  });

  it("creates the new shape on a fresh database", () => {
    const { db } = openTempDatabase();
    expect(columns(db, "instance_settings")).toEqual([
      "id", "concurrency_pipeline", "max_data_gb", "low_water_free_gb", "low_water_free_ratio", "upload_retention_default",
      "updated_at", "credentials_reset_at", "cache_root", "cache_migration_json",
    ]);
    expect(columns(db, "work_unit")).toEqual(expect.arrayContaining(["retry_count", "retry_not_before"]));
    seedStageRun(db);
    const unit = { stage_run_id: "s", status: "pending", attempt: 1, input_digest: "d" };
    insertRow(db, "work_unit", { ...unit, id: "a", unit_key: "a" });
    insertRow(db, "work_unit", { ...unit, id: "b", unit_key: "b", retry_count: 3, retry_not_before: T0 });
    expect(() => insertRow(db, "work_unit", { ...unit, id: "x", unit_key: "x", retry_count: -1 })).toThrow(/CHECK/);
    expect(db.prepare("SELECT id, retry_count, retry_not_before FROM work_unit ORDER BY id").all()).toEqual([
      { id: "a", retry_count: 0, retry_not_before: null },
      { id: "b", retry_count: 3, retry_not_before: T0 },
    ]);
    db.close();
  });

  it("is refused by a build that predates it", () => {
    const dir = tempDataDir();
    const file = join(dir, "amber.db");
    openDatabase(file, { backupDir: join(dir, "backups") }).db.close();
    let thrown: unknown;
    try {
      openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 12) });
    } catch (error) {
      thrown = error;
    }
    expect(isAmberError(thrown) && thrown.appError.code).toBe("schema_version_unsupported");
  });
});
