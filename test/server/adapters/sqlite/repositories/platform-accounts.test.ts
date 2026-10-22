import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import { countRows, insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;

/** A secret row with placeholder envelope bytes; the repository never reads them. */
function secret(id: string, userId: string): void {
  insertRow(db, "secret", {
    id, user_id: userId, envelope_version: 1, kdf_salt: randomBytes(16), nonce: randomBytes(12), ciphertext: randomBytes(8), auth_tag: randomBytes(16), created_at: T0, updated_at: T0,
  });
}

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
  secret("s-alice-b", "alice");
  secret("s-alice-y", "alice");
  secret("s-bob-b", "bob");
});

describe("platform account repository", () => {
  it("keeps one account per owner and platform and lists them by platform", () => {
    repository.withTransaction((scope) => {
      scope.platformAccounts.insert({ id: "p2", userId: "alice", platform: "youtube", credentialRef: "s-alice-y", status: "unknown" });
      scope.platformAccounts.insert({ id: "p1", userId: "alice", platform: "bilibili", credentialRef: "s-alice-b", status: "valid", checkedAt: T0 });
      scope.platformAccounts.insert({ id: "p3", userId: "bob", platform: "bilibili", credentialRef: "s-bob-b", status: "unknown" });
    });
    expect(repository.withTransaction((scope) => scope.platformAccounts.list("alice"))).toEqual([
      { id: "p1", userId: "alice", platform: "bilibili", credentialRef: "s-alice-b", status: "valid", checkedAt: T0 },
      { id: "p2", userId: "alice", platform: "youtube", credentialRef: "s-alice-y", status: "unknown" },
    ]);
    expect(repository.withTransaction((scope) => scope.platformAccounts.get("bob", "youtube"))).toBeUndefined();
    expect(() =>
      repository.withTransaction((scope) => scope.platformAccounts.insert({ id: "p4", userId: "alice", platform: "bilibili", credentialRef: "s-alice-y", status: "unknown" })),
    ).toThrow();
  });

  it("refuses a credential that belongs to another owner", () => {
    expect(() =>
      repository.withTransaction((scope) => scope.platformAccounts.insert({ id: "p", userId: "alice", platform: "bilibili", credentialRef: "s-bob-b", status: "unknown" })),
    ).toThrow();
  });

  it("updates the checked status of the owner's account only", () => {
    repository.withTransaction((scope) => scope.platformAccounts.insert({ id: "p1", userId: "alice", platform: "bilibili", credentialRef: "s-alice-b", status: "unknown" }));
    repository.withTransaction((scope) => scope.platformAccounts.setStatus("alice", "bilibili", "expired", T0 + 1));
    expect(repository.withTransaction((scope) => scope.platformAccounts.get("alice", "bilibili"))).toMatchObject({ status: "expired", checkedAt: T0 + 1 });
    repository.withTransaction((scope) => scope.platformAccounts.setStatus("alice", "bilibili", "unknown", undefined));
    expect(repository.withTransaction((scope) => scope.platformAccounts.get("alice", "bilibili"))).not.toHaveProperty("checkedAt");
    expect(() => repository.withTransaction((scope) => scope.platformAccounts.setStatus("bob", "bilibili", "valid", T0))).toThrow();
  });

  it("deletes the account together with its secret", () => {
    repository.withTransaction((scope) => scope.platformAccounts.insert({ id: "p1", userId: "alice", platform: "bilibili", credentialRef: "s-alice-b", status: "unknown" }));
    expect(repository.withTransaction((scope) => scope.platformAccounts.delete("bob", "bilibili"))).toBe(false);
    expect(repository.withTransaction((scope) => scope.platformAccounts.delete("alice", "bilibili"))).toBe(true);
    expect(repository.withTransaction((scope) => scope.platformAccounts.delete("alice", "bilibili"))).toBe(false);
    expect(countRows(db, "secret", "id = ?", "s-alice-b")).toBe(0);
    expect(countRows(db, "secret")).toBe(2);
  });
});
