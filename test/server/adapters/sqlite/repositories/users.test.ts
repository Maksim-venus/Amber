import { describe, expect, it } from "vitest";
import { sqliteUserRepository } from "../../../../../src/server/adapters/sqlite/repositories/users.ts";
import { openTempDatabase } from "../../../../tools/sqlite.ts";

describe("sqliteUserRepository", () => {
  it("lists, updates and counts active administrators", () => {
    const { db } = openTempDatabase();
    const users = sqliteUserRepository(db);
    users.insert({ id: "b", role: "user", status: "active", createdAt: 2 });
    users.insert({ id: "a", role: "admin", status: "active", displayName: "A", createdAt: 1 });
    expect(users.list().map((user) => user.id)).toEqual(["a", "b"]);
    expect(users.countActiveAdmins()).toBe(1);
    users.update({ id: "b", role: "admin", status: "active", storageLimitGB: 5, createdAt: 2 });
    expect(users.get("b")).toEqual({ id: "b", role: "admin", status: "active", storageLimitGB: 5, createdAt: 2 });
    expect(users.countActiveAdmins()).toBe(2);
    users.update({ id: "a", role: "admin", status: "suspended", createdAt: 1 });
    expect(users.get("a")).toEqual({ id: "a", role: "admin", status: "suspended", createdAt: 1 });
    expect(users.countActiveAdmins()).toBe(1);
    expect(() => users.update({ id: "ghost", role: "user", status: "active", createdAt: 1 })).toThrow(/not found/);
  });

  it("stores one credential per user with unique usernames", () => {
    const { db } = openTempDatabase();
    const users = sqliteUserRepository(db);
    users.insert({ id: "a", role: "admin", status: "active", createdAt: 1 });
    users.insert({ id: "b", role: "user", status: "active", createdAt: 2 });
    expect(users.anyCredential()).toBe(false);
    users.putCredential({ userId: "a", username: "alice", passwordHash: "<hash-a>", mustChangePassword: true });
    expect(users.anyCredential()).toBe(true);
    expect(users.findCredentialByUsername("alice")).toEqual({ userId: "a", username: "alice", passwordHash: "<hash-a>", mustChangePassword: true });
    users.putCredential({ userId: "a", username: "alice", passwordHash: "<hash-a2>", mustChangePassword: false });
    expect(users.getCredential("a")?.passwordHash).toBe("<hash-a2>");
    expect(() => users.putCredential({ userId: "b", username: "alice", passwordHash: "<hash-b>", mustChangePassword: false })).toThrow(/UNIQUE/);
    expect(users.findCredentialByUsername("nobody")).toBeUndefined();
    expect(users.delete("a")).toBe(true);
    expect(users.getCredential("a")).toBeUndefined();
  });
});
