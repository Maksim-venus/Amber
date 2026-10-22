import { describe, expect, it } from "vitest";
import { SqliteRepository } from "../../../src/server/adapters/sqlite/repository.ts";
import { ensureLocalUser } from "../../../src/server/application/ensure-local-user.ts";
import { LOCAL_USER_ID } from "../../../src/server/domain/user.ts";
import { countRows, openTempDatabase } from "../../tools/sqlite.ts";

describe("ensureLocalUser", () => {
  it("creates the implicit admin once and returns the same user on every later start", () => {
    const { db } = openTempDatabase();
    const repository = new SqliteRepository(db);
    const first = ensureLocalUser(repository, () => 1000);
    const second = ensureLocalUser(repository, () => 2000);
    expect(first).toEqual({ id: LOCAL_USER_ID, role: "admin", status: "active", createdAt: 1000 });
    expect(second).toEqual(first);
    expect(countRows(db, "user")).toBe(1);
    expect(countRows(db, "user_credential")).toBe(0);
  });
});
