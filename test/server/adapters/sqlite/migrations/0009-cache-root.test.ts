import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../../../src/server/adapters/sqlite/database.ts";
import { latestSchemaVersion, MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { insertRow, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;

describe("migration 0009: cache root and migration marker", () => {
  it("adds the two nullable columns to an existing instance settings row", () => {
    const dir = tempDataDir();
    const file = join(dir, "amber.db");
    const { db: v8 } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 8) });
    insertRow(v8, "instance_settings", {
      id: 1, concurrency_heavy: 1, concurrency_pipeline: 1, concurrency_llm: 1, max_data_gb: 1,
      low_water_free_gb: 1, low_water_free_ratio: 0.1, upload_retention_default: "keep", updated_at: T0,
    });
    v8.close();

    const { db, from, to } = openDatabase(file, { backupDir: join(dir, "backups") });
    expect({ from, to }).toEqual({ from: 8, to: latestSchemaVersion() });
    expect(db.prepare("SELECT cache_root, cache_migration_json FROM instance_settings").get()).toEqual({ cache_root: null, cache_migration_json: null });
    db.prepare("UPDATE instance_settings SET cache_root = ?, cache_migration_json = ?").run("D:\\Amber Cache", JSON.stringify({ id: "m", from: "a", to: "b", phase: "copying" }));
    expect(() => db.prepare("UPDATE instance_settings SET cache_migration_json = '{'").run()).toThrow(/CHECK/);
    db.close();
  });
});
