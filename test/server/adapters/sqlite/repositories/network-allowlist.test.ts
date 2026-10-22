import { describe, expect, it } from "vitest";
import { sqliteNetworkAllowlistRepository } from "../../../../../src/server/adapters/sqlite/repositories/network-allowlist.ts";
import { insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

describe("sqliteNetworkAllowlistRepository", () => {
  it("replaces the whole list and lists by origin", () => {
    const { db } = openTempDatabase();
    insertRow(db, "user", { id: "a", role: "admin", status: "active", created_at: 1 });
    const allowlist = sqliteNetworkAllowlistRepository(db);
    expect(allowlist.list()).toEqual([]);
    allowlist.replace([
      { origin: "https://relay.example:8443", createdByUserId: "a", createdAt: 2 },
      { origin: "http://10.0.0.5", createdAt: 3 },
    ]);
    expect(allowlist.list()).toEqual([
      { origin: "http://10.0.0.5", createdAt: 3 },
      { origin: "https://relay.example:8443", createdByUserId: "a", createdAt: 2 },
    ]);
    allowlist.replace([]);
    expect(allowlist.list()).toEqual([]);
  });
});
