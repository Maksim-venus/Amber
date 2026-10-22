import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase, readSchemaVersion } from "../../../../src/server/adapters/sqlite/database.ts";
import { latestSchemaVersion, MIGRATIONS } from "../../../../src/server/adapters/sqlite/migrations.ts";
import { isAmberError } from "../../../../src/server/domain/errors.ts";
import { SQLITE_BUSY_TIMEOUT_MS } from "../../../../src/shared/defaults.ts";
import { tempDataDir } from "../../../tools/sqlite.ts";

function paths() {
  const dir = tempDataDir("amber-db-");
  return { dir, file: join(dir, "amber.db"), backupDir: join(dir, "backups") };
}

/** A database left at `version` and closed cleanly, as an older or newer build would leave it. */
function databaseAt(file: string, version: number): void {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE m0_sentinel (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, marker TEXT NOT NULL)");
  db.exec("INSERT INTO m0_sentinel VALUES (1, 1, 'marker')");
  db.pragma(`user_version = ${version}`);
  db.close();
}

const fingerprint = (dir: string, file: string) => ({
  sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
  mtimeMs: statSync(file).mtimeMs,
  entries: readdirSync(dir).sort(),
});

describe("openDatabase", () => {
  it("migrates a new database, then enables WAL, foreign keys and the busy timeout", () => {
    const { file, backupDir } = paths();
    const { db, from, to, backupPath } = openDatabase(file, { backupDir });
    expect({ from, to, backupPath }).toEqual({ from: 0, to: latestSchemaVersion(), backupPath: undefined });
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(SQLITE_BUSY_TIMEOUT_MS);
    expect(existsSync(backupDir)).toBe(false);
    db.close();
  });

  it("refuses a newer schema with schema_version_unsupported and leaves the file untouched", () => {
    const { dir, file, backupDir } = paths();
    databaseAt(file, latestSchemaVersion() + 1);
    const before = fingerprint(dir, file);
    let thrown: unknown;
    try {
      openDatabase(file, { backupDir });
    } catch (error) {
      thrown = error;
    }
    expect(isAmberError(thrown) && thrown.appError.code).toBe("schema_version_unsupported");
    expect(fingerprint(dir, file)).toEqual(before);
  });

  it("snapshots an existing database with VACUUM INTO before applying pending migrations", () => {
    const { dir, file, backupDir } = paths();
    databaseAt(file, 1);
    const { db, from, to, backupPath } = openDatabase(file, { backupDir, now: () => 1234 });
    db.close();
    expect({ from, to }).toEqual({ from: 1, to: latestSchemaVersion() });
    expect(backupPath).toBe(join(dir, "backups", `pre-migration-v1-v${latestSchemaVersion()}-1234.sqlite`));
    const snapshot = new Database(backupPath as string, { readonly: true });
    expect(snapshot.pragma("user_version", { simple: true })).toBe(1);
    expect(snapshot.prepare("SELECT marker FROM m0_sentinel").get()).toEqual({ marker: "marker" });
    snapshot.close();
  });

  it("stops before migrating when the snapshot fails", () => {
    const { file, dir } = paths();
    databaseAt(file, 1);
    const blocked = join(dir, "not-a-directory");
    writeFileSync(blocked, "");
    expect(() => openDatabase(file, { backupDir: blocked })).toThrow();
    expect(readSchemaVersion(file)).toBe(1);
  });

  it("does not snapshot a database that is already current", () => {
    const { file, backupDir } = paths();
    openDatabase(file, { backupDir }).db.close();
    const reopened = openDatabase(file, { backupDir });
    expect(reopened.backupPath).toBeUndefined();
    reopened.db.close();
  });
});

describe("readSchemaVersion", () => {
  it("is 0 for a missing or empty file", () => {
    const { file } = paths();
    expect(readSchemaVersion(file)).toBe(0);
    writeFileSync(file, "");
    expect(readSchemaVersion(file)).toBe(0);
  });

  it("reads a cleanly closed database from its header without creating files", () => {
    const { dir, file } = paths();
    databaseAt(file, 7);
    const before = readdirSync(dir).sort();
    expect(readSchemaVersion(file)).toBe(7);
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it("sees a version that is still only in the WAL", () => {
    const { file } = paths();
    databaseAt(file, 1);
    const writer = new Database(file);
    writer.pragma("wal_autocheckpoint = 0");
    writer.pragma("user_version = 9");
    // The writer stays open, so the change lives only in the WAL and the header is stale.
    expect(readSchemaVersion(file)).toBe(9);
    writer.close();
  });

  it("matches the migrations the build knows", () => {
    expect(latestSchemaVersion()).toBe(MIGRATIONS.length);
  });
});
