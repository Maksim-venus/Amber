import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import { countRows, insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
  insertRow(db, "content", { id: "c", user_id: "alice", source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
});

describe("reference text repository", () => {
  it("stores texts on the owner's Content and lists them in creation order", () => {
    repository.withTransaction((scope) => {
      scope.referenceTexts.insert("alice", { id: "r2", contentId: "c", origin: "md_import", text: "# notes", createdAt: T0 + 1 });
      scope.referenceTexts.insert("alice", { id: "r1", contentId: "c", origin: "txt_import", text: "plain", createdAt: T0 });
    });
    expect(repository.withTransaction((scope) => scope.referenceTexts.listByContent("alice", "c"))).toEqual([
      { id: "r1", contentId: "c", origin: "txt_import", text: "plain", createdAt: T0 },
      { id: "r2", contentId: "c", origin: "md_import", text: "# notes", createdAt: T0 + 1 },
    ]);
    expect(repository.withTransaction((scope) => scope.referenceTexts.listByContent("bob", "c"))).toEqual([]);
  });

  it("refuses another owner's Content", () => {
    expect(() => repository.withTransaction((scope) => scope.referenceTexts.insert("bob", { id: "r", contentId: "c", origin: "txt_import", text: "x", createdAt: T0 }))).toThrow();
    expect(countRows(db, "reference_text")).toBe(0);
  });

  it("goes with its Content", () => {
    repository.withTransaction((scope) => scope.referenceTexts.insert("alice", { id: "r", contentId: "c", origin: "txt_import", text: "x", createdAt: T0 }));
    repository.withTransaction((scope) => scope.contents.delete("alice", "c"));
    expect(countRows(db, "reference_text")).toBe(0);
  });
});
