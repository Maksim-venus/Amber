import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../../../src/server/adapters/sqlite/database.ts";
import { latestSchemaVersion, MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { insertRow, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;

describe("migration 0011: a Content's own title and pin", () => {
  it("adds two nullable columns, leaving existing Contents unrenamed and unpinned", () => {
    const dir = tempDataDir();
    const file = join(dir, "amber.db");
    const { db: v10 } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 10) });
    insertRow(v10, "user", { id: "u", role: "user", status: "active", created_at: T0 });
    insertRow(v10, "content", { id: "c", user_id: "u", source_kind: "local", title: "原标题", processing_status: "queued", created_at: T0, updated_at: T0 });
    v10.close();

    const { db, from, to } = openDatabase(file, { backupDir: join(dir, "backups") });
    expect({ from, to }).toEqual({ from: 10, to: latestSchemaVersion() });
    expect(db.prepare("SELECT title, custom_title, pinned_at FROM content WHERE id = 'c'").get()).toEqual({ title: "原标题", custom_title: null, pinned_at: null });
    db.close();
  });
});
