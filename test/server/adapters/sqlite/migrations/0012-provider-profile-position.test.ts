import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../../../src/server/adapters/sqlite/database.ts";
import { latestSchemaVersion, MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { insertRow, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;

describe("migration 0012: the user's order of provider profiles", () => {
  it("numbers each user's existing profiles in their former created_at, id order", () => {
    const dir = tempDataDir();
    const file = join(dir, "amber.db");
    const { db: v11 } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 11) });
    for (const id of ["alice", "bob"]) insertRow(v11, "user", { id, role: "user", status: "active", created_at: T0 });
    const profile = (id: string, userId: string, createdAt: number) =>
      insertRow(v11, "provider_profile", { id, user_id: userId, name: id, protocol: "openai_compatible", base_url: "https://llm.invalid", created_at: createdAt });
    profile("late", "alice", T0 + 2);
    profile("b", "alice", T0 + 1);
    profile("a", "alice", T0 + 1);
    profile("only", "bob", T0 + 9);
    v11.close();

    const { db, from, to } = openDatabase(file, { backupDir: join(dir, "backups") });
    expect({ from, to }).toEqual({ from: 11, to: latestSchemaVersion() });
    expect(db.prepare("SELECT id, position FROM provider_profile ORDER BY user_id, position").all()).toEqual([
      { id: "a", position: 0 },
      { id: "b", position: 1 },
      { id: "late", position: 2 },
      { id: "only", position: 0 },
    ]);
    db.close();
  });
});
