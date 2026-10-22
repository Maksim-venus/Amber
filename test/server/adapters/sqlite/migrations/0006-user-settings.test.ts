import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../../../src/server/adapters/sqlite/database.ts";
import { latestSchemaVersion, MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { insertRow, tableNames, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;

describe("migration 0006: user settings, sentinel retired", () => {
  it("creates user_settings and drops the start-up sentinel from a version 5 database", () => {
    const dir = tempDataDir();
    const file = join(dir, "amber.db");
    const { db: v5 } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 5) });
    expect(tableNames(v5)).toContain("m0_sentinel");
    insertRow(v5, "user", { id: "u", role: "user", status: "active", created_at: T0 });
    v5.close();

    const { db, from, to } = openDatabase(file, { backupDir: join(dir, "backups") });
    expect({ from, to }).toEqual({ from: 5, to: latestSchemaVersion() });
    expect(tableNames(db)).not.toContain("m0_sentinel");
    insertRow(db, "user_settings", { user_id: "u", theme: "light", language: "zh-CN", shortcuts_json: "{}", updated_at: T0 });
    expect(() => insertRow(db, "user_settings", { user_id: "u", theme: "light", language: "en", shortcuts_json: "{}", updated_at: T0 })).toThrow(/UNIQUE|PRIMARY/);
    db.close();
  });

  it("enforces the structural checks and follows its user and template", () => {
    const dir = tempDataDir();
    const { db } = openDatabase(join(dir, "amber.db"), { backupDir: join(dir, "backups") });
    insertRow(db, "user", { id: "u", role: "user", status: "active", created_at: T0 });
    insertRow(db, "summary_template", { id: "t", user_id: "u", builtin: 0, name: "t", current_version: 1 });
    const row = { user_id: "u", theme: "light", language: "zh-CN", shortcuts_json: "{}", updated_at: T0 };
    expect(() => insertRow(db, "user_settings", { ...row, shortcuts_json: "{" })).toThrow(/CHECK/);
    expect(() => insertRow(db, "user_settings", { ...row, user_id: "ghost" })).toThrow(/FOREIGN KEY/);
    insertRow(db, "user_settings", { ...row, default_summary_template_id: "t" });
    db.prepare("DELETE FROM summary_template WHERE id = 't'").run();
    expect(db.prepare("SELECT default_summary_template_id AS id FROM user_settings").get()).toEqual({ id: null });
    db.prepare("DELETE FROM user WHERE id = 'u'").run();
    expect(db.prepare("SELECT count(*) AS n FROM user_settings").get()).toEqual({ n: 0 });
    db.close();
  });
});
