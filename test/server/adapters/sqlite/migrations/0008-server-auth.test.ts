import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../../../src/server/adapters/sqlite/database.ts";
import { latestSchemaVersion, MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { insertRow, tableNames, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;

describe("migration 0008: sessions, network allowlist, credentials reset audit", () => {
  it("adds the tables and keeps an existing instance settings row", () => {
    const dir = tempDataDir();
    const file = join(dir, "amber.db");
    const { db: v7 } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 7) });
    insertRow(v7, "instance_settings", {
      id: 1, concurrency_heavy: 1, concurrency_pipeline: 1, concurrency_llm: 1, max_data_gb: 1,
      low_water_free_gb: 1, low_water_free_ratio: 0.1, upload_retention_default: "keep", updated_at: T0,
    });
    v7.close();

    const { db, from, to } = openDatabase(file, { backupDir: join(dir, "backups") });
    expect({ from, to }).toEqual({ from: 7, to: latestSchemaVersion() });
    expect(tableNames(db)).toEqual(expect.arrayContaining(["session", "network_allowlist"]));
    expect(db.prepare("SELECT credentials_reset_at AS at FROM instance_settings").get()).toEqual({ at: null });
    db.close();
  });

  it("ties sessions to their user and keeps allowlist entries when the actor is deleted", () => {
    const dir = tempDataDir();
    const { db } = openDatabase(join(dir, "amber.db"), { backupDir: join(dir, "backups") });
    insertRow(db, "user", { id: "u", role: "admin", status: "active", created_at: T0 });
    const session = { session_id_hash: "h", user_id: "u", created_at: T0, last_seen_at: T0, expires_at: T0 + 1 };
    expect(() => insertRow(db, "session", { ...session, expires_at: T0 })).toThrow(/CHECK/);
    expect(() => insertRow(db, "session", { ...session, user_id: "ghost" })).toThrow(/FOREIGN KEY/);
    insertRow(db, "session", session);
    insertRow(db, "network_allowlist", { origin: "http://relay.lan:8080", created_by_user_id: "u", created_at: T0 });
    db.prepare("DELETE FROM user WHERE id = 'u'").run();
    expect(db.prepare("SELECT count(*) AS n FROM session").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT created_by_user_id AS actor FROM network_allowlist").get()).toEqual({ actor: null });
    db.close();
  });
});
