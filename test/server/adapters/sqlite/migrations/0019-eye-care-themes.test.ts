import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase, type SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { migrate as applyMigrations, MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { countRows, insertRow, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
const json = (value: unknown): string => JSON.stringify(value);

const columnNames = (db: SqliteConnection): string[] =>
  (db.prepare("SELECT name FROM pragma_table_info('user_settings')").all() as Array<{ name: string }>).map((row) => row.name);
const allSettings = (db: SqliteConnection): unknown[] => db.prepare("SELECT * FROM user_settings ORDER BY user_id").all();

/** One user at schema 18 whose settings row has every nullable column filled with a real value. */
function seedUser(db: SqliteConnection, userId: string, theme: string, browser: string): void {
  insertRow(db, "user", { id: userId, role: "user", status: "active", created_at: T0 });
  insertRow(db, "summary_template", { id: `t-${userId}`, user_id: userId, builtin: 0, name: "课程笔记", current_version: 1 });
  insertRow(db, "user_settings", {
    user_id: userId,
    theme,
    language: "zh-CN",
    default_summary_template_id: `t-${userId}`,
    shortcuts_json: json({ toggleTheme: "Alt+T" }),
    chat_model_ref_json: json({ providerProfileId: `p-${userId}`, modelId: "chat-model" }),
    default_model_ref_json: json({ providerProfileId: `p-${userId}`, modelId: "summary-model" }),
    default_output_language: "en",
    platform_cookie_browser: browser,
    updated_at: T0 + 1,
    default_asr_model_ref_json: json({ asrProfileId: `a-${userId}`, modelId: "fun-asr" }),
  });
}

function atVersion18(): { dir: string; file: string; rows: unknown[]; columns: string[] } {
  const dir = tempDataDir();
  const file = join(dir, "amber.db");
  const { db } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 18) });
  seedUser(db, "alice", "light", "firefox");
  seedUser(db, "bob", "dark", "edge");
  const rows = allSettings(db);
  const columns = columnNames(db);
  db.close();
  return { dir, file, rows, columns };
}

const migrate = (dir: string, file: string) => openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 19) });

describe("migration 0019: user settings without member checks on theme and cookie browser", () => {
  it("keeps every row, value and column in place", () => {
    const { dir, file, rows, columns } = atVersion18();
    const { db, from, to } = migrate(dir, file);
    expect({ from, to }).toEqual({ from: 18, to: 19 });
    expect(rows).toHaveLength(2);
    expect(allSettings(db)).toEqual(rows);
    expect(columnNames(db)).toEqual(columns);
    expect(columns.at(-1)).toBe("default_asr_model_ref_json");
    expect(countRows(db, "sqlite_master", "name = 'user_settings_v19'")).toBe(0);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });

  it("migrates the same way with foreign keys enforced, as a staged restore does", () => {
    const { file, rows } = atVersion18();
    const db = new Database(file);
    db.pragma("foreign_keys = ON");
    expect(applyMigrations(db, MIGRATIONS.slice(0, 19))).toEqual({ from: 18, to: 19 });
    expect(allSettings(db)).toEqual(rows);
    expect(countRows(db, "summary_template")).toBe(2);
    db.close();
  });

  it("stores the eye-care themes and still enforces the structural checks and both references", () => {
    const { dir, file } = atVersion18();
    const { db } = migrate(dir, file);
    insertRow(db, "user", { id: "carol", role: "user", status: "active", created_at: T0 });
    insertRow(db, "user", { id: "dave", role: "user", status: "active", created_at: T0 });
    const row = { theme: "light", language: "zh-CN", shortcuts_json: "{}", updated_at: T0 };
    insertRow(db, "user_settings", { ...row, user_id: "carol", theme: "bean-green" });
    insertRow(db, "user_settings", { ...row, user_id: "dave", theme: "parchment" });
    expect(db.prepare("SELECT user_id, theme FROM user_settings WHERE user_id IN ('carol', 'dave') ORDER BY user_id").all()).toEqual([
      { user_id: "carol", theme: "bean-green" },
      { user_id: "dave", theme: "parchment" },
    ]);

    const fresh = { ...row, user_id: "erin" };
    insertRow(db, "user", { id: "erin", role: "user", status: "active", created_at: T0 });
    expect(() => insertRow(db, "user_settings", { ...fresh, shortcuts_json: "{" })).toThrow(/CHECK/);
    for (const column of ["chat_model_ref_json", "default_model_ref_json", "default_asr_model_ref_json"]) {
      expect(() => insertRow(db, "user_settings", { ...fresh, [column]: "{oops" })).toThrow(/CHECK/);
    }
    expect(() => insertRow(db, "user_settings", { ...fresh, theme: null })).toThrow(/NOT NULL/);
    expect(() => insertRow(db, "user_settings", { ...fresh, updated_at: "later" })).toThrow(/cannot store TEXT value in INTEGER column/);
    expect(() => insertRow(db, "user_settings", { ...row, user_id: "ghost" })).toThrow(/FOREIGN KEY/);
    expect(() => insertRow(db, "user_settings", { ...row, user_id: "carol" })).toThrow(/UNIQUE|PRIMARY/);

    db.prepare("DELETE FROM summary_template WHERE id = 't-alice'").run();
    expect(db.prepare("SELECT default_summary_template_id AS id FROM user_settings WHERE user_id = 'alice'").get()).toEqual({ id: null });
    db.prepare("DELETE FROM user WHERE id = 'bob'").run();
    expect(countRows(db, "user_settings", "user_id = 'bob'")).toBe(0);
    expect(countRows(db, "user_settings")).toBe(3);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });
});
