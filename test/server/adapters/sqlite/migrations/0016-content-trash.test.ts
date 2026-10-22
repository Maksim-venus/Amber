import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../../../src/server/adapters/sqlite/database.ts";
import { latestSchemaVersion, MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { insertRow, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;

function migratedFrom15() {
  const dir = tempDataDir();
  const file = join(dir, "amber.db");
  const { db: v15 } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 15) });
  insertRow(v15, "user", { id: "u", role: "user", status: "active", created_at: T0 });
  insertRow(v15, "content", { id: "c", user_id: "u", source_kind: "local", title: "第一讲", processing_status: "succeeded", created_at: T0, updated_at: T0 });
  v15.close();
  return { dir, ...openDatabase(file, { backupDir: join(dir, "backups") }) };
}

const indexes = (db: ReturnType<typeof migratedFrom15>["db"], table: string) =>
  (db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name").all(table) as Array<{
    name: string;
    sql: string;
  }>);

describe("migration 0016: the content trash", () => {
  it("adds a nullable trashed_at, leaving existing Contents outside the trash, with the per-user and due indexes", () => {
    const { db, from, to } = migratedFrom15();
    expect({ from, to }).toEqual({ from: 15, to: latestSchemaVersion() });
    expect(db.prepare("SELECT trashed_at FROM content WHERE id = 'c'").get()).toEqual({ trashed_at: null });
    const byName = new Map(indexes(db, "content").map((index) => [index.name, index.sql]));
    expect(byName.get("content_trashed")).toMatch(/\(user_id, trashed_at DESC, id DESC\) WHERE trashed_at IS NOT NULL/);
    expect(byName.get("content_trash_due")).toMatch(/\(trashed_at, id\) WHERE trashed_at IS NOT NULL/);
    db.close();
  });

  it("creates pending_file_delete as an instance-level queue: unique per root and ref, no foreign key to the user", () => {
    const { db } = migratedFrom15();
    expect(db.prepare("SELECT count(*) AS n FROM pragma_foreign_key_list('pending_file_delete')").get()).toEqual({ n: 0 });
    const row = { store: "cache", root_path: "/cache/media", storage_ref: "media/第一讲.mp4", next_attempt_at: T0, created_at: T0 };
    insertRow(db, "pending_file_delete", { id: "p1", ...row, user_id: "gone-user" });
    expect(() => insertRow(db, "pending_file_delete", { id: "p2", ...row })).toThrow(/UNIQUE/);
    // The same ref under another root is another file.
    insertRow(db, "pending_file_delete", { id: "p3", ...row, root_path: "/other/media" });
    expect(() => insertRow(db, "pending_file_delete", { id: "p4", ...row, store: "elsewhere", root_path: "/x" })).toThrow(/CHECK/);
    expect(db.prepare("SELECT attempts, expected_size_bytes, last_error FROM pending_file_delete WHERE id = 'p1'").get()).toEqual({
      attempts: 0,
      expected_size_bytes: null,
      last_error: null,
    });
    expect(indexes(db, "pending_file_delete").map((index) => index.name)).toEqual(["pending_file_delete_due"]);
    db.close();
  });
});
