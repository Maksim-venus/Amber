import { readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../src/server/adapters/sqlite/database.ts";
import { latestSchemaVersion, migrate, MIGRATIONS } from "../../../../src/server/adapters/sqlite/migrations.ts";
import { isAmberError } from "../../../../src/server/domain/errors.ts";

const MIGRATIONS_DIR = join(import.meta.dirname, "../../../../src/server/adapters/sqlite/migrations");
const memoryDb = (): SqliteConnection => new Database(":memory:");
const tableExists = (db: SqliteConnection, name: string) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

describe("MIGRATIONS", () => {
  it("are consecutive from 1 and each lives in its own NNNN-<name>.ts file", () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual(MIGRATIONS.map((_, index) => index + 1));
    const files = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".ts")).sort();
    expect(files).toEqual(
      MIGRATIONS.map((migration) => `${String(migration.version).padStart(4, "0")}-${migration.name}.ts`),
    );
  });
});

describe("migrate", () => {
  it("brings a new database to the latest version, where the start-up sentinel table no longer exists", () => {
    const db = memoryDb();
    expect(migrate(db)).toEqual({ from: 0, to: latestSchemaVersion() });
    expect(db.pragma("user_version", { simple: true })).toBe(latestSchemaVersion());
    expect(tableExists(db, "m0_sentinel")).toBe(false);
    expect(tableExists(db, "user_settings")).toBe(true);
  });

  it("upgrades a version 1 database, dropping its sentinel table on the way", () => {
    const db = memoryDb();
    migrate(db, MIGRATIONS.slice(0, 1));
    expect(db.prepare("SELECT * FROM m0_sentinel").all()).toHaveLength(1);
    expect(migrate(db)).toEqual({ from: 1, to: latestSchemaVersion() });
    expect(tableExists(db, "m0_sentinel")).toBe(false);
  });

  it("is idempotent", () => {
    const db = memoryDb();
    migrate(db);
    const latest = latestSchemaVersion();
    expect(migrate(db)).toEqual({ from: latest, to: latest });
  });

  it("refuses a database written by a newer build with the schema_version_unsupported error class", () => {
    const db = memoryDb();
    db.pragma("user_version = 99");
    let thrown: unknown;
    try {
      migrate(db);
    } catch (error) {
      thrown = error;
    }
    expect(isAmberError(thrown) && thrown.appError).toMatchObject({
      class: "schema_version_unsupported",
      code: "schema_version_unsupported",
      retryDisposition: "never",
    });
  });

  it("rolls back a failing migration together with its version bump", () => {
    const db = memoryDb();
    expect(() => migrate(db, [{ version: 1, name: "broken", sql: "CREATE TABLE t (x); INSERT INTO missing VALUES (1);" }])).toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 't'").all()).toEqual([]);
  });

  it("rejects a migration that leaves foreign key violations while enforcement is off", () => {
    const db = memoryDb();
    // Table rebuilds run with foreign keys off; the post-migration check still catches damage.
    db.pragma("foreign_keys = OFF");
    const sql = "CREATE TABLE p (id TEXT PRIMARY KEY); CREATE TABLE c (p TEXT REFERENCES p (id)); INSERT INTO c VALUES ('x');";
    expect(() => migrate(db, [{ version: 1, name: "dangling", sql }])).toThrow(/foreign key violations/);
  });
});
