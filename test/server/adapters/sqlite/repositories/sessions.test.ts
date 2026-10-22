import { describe, expect, it } from "vitest";
import { sqliteSessionRepository } from "../../../../../src/server/adapters/sqlite/repositories/sessions.ts";
import { insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;

function setup() {
  const { db } = openTempDatabase();
  insertRow(db, "user", { id: "a", role: "admin", status: "active", created_at: T0 });
  insertRow(db, "user", { id: "b", role: "user", status: "active", created_at: T0 });
  const sessions = sqliteSessionRepository(db);
  for (const [hash, userId] of [["a1", "a"], ["a2", "a"], ["b1", "b"]] as const) {
    sessions.insert({ sessionIdHash: hash, userId, createdAt: T0, lastSeenAt: T0, expiresAt: T0 + 1000 });
  }
  return { db, sessions };
}

describe("sqliteSessionRepository", () => {
  it("slides, revokes one and revokes all of a user except one", () => {
    const { sessions } = setup();
    sessions.touch("a1", T0 + 10, T0 + 2000);
    expect(sessions.get("a1")).toEqual({ sessionIdHash: "a1", userId: "a", createdAt: T0, lastSeenAt: T0 + 10, expiresAt: T0 + 2000 });
    expect(sessions.revoke("b1", T0 + 5)).toBe(true);
    expect(sessions.revoke("b1", T0 + 6)).toBe(false);
    expect(sessions.get("b1")?.revokedAt).toBe(T0 + 5);
    // A revoked session no longer slides.
    sessions.touch("b1", T0 + 20, T0 + 3000);
    expect(sessions.get("b1")?.expiresAt).toBe(T0 + 1000);
    expect(sessions.revokeAllOf("a", T0 + 7, { except: "a2" })).toEqual(["a1"]);
    expect(sessions.get("a2")?.revokedAt).toBeUndefined();
    expect(sessions.revokeAllOf("a", T0 + 8).sort()).toEqual(["a2"]);
    expect(sessions.get("nope")).toBeUndefined();
  });

  it("deletes expired and revoked rows only", () => {
    const { sessions } = setup();
    sessions.revoke("b1", T0 + 1);
    sessions.touch("a2", T0, T0 + 5000);
    expect(sessions.deleteStale(T0 + 1000)).toBe(2);
    expect(sessions.get("a1")).toBeUndefined();
    expect(sessions.get("b1")).toBeUndefined();
    expect(sessions.get("a2")).toBeDefined();
  });
});
