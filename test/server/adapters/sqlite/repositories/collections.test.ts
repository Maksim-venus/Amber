import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import { insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
});

describe("collection repository", () => {
  it("finds a platform collection by its platform id, per owner", () => {
    repository.withTransaction((scope) => {
      scope.collections.insert({ id: "ca", userId: "alice", name: "Course", platformCollectionId: "1_2", createdAt: T0, updatedAt: T0 });
      scope.collections.insert({ id: "cb", userId: "bob", name: "Course", platformCollectionId: "1_2", createdAt: T0, updatedAt: T0 });
      scope.collections.insert({ id: "loose", userId: "alice", name: "Mine", createdAt: T0, updatedAt: T0 });
    });
    const find = (owner: string, id: string) => repository.withTransaction((scope) => scope.collections.findByPlatformCollectionId(owner, id));
    expect(find("alice", "1_2")).toEqual({ id: "ca", userId: "alice", name: "Course", platformCollectionId: "1_2", createdAt: T0, updatedAt: T0 });
    expect(find("bob", "1_2")?.id).toBe("cb");
    expect(find("alice", "1_series_2")).toBeUndefined();
  });

  it("only files the owner's Contents into the owner's collections", () => {
    insertRow(db, "content", { id: "c", user_id: "alice", source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
    repository.withTransaction((scope) => {
      scope.collections.insert({ id: "ca", userId: "alice", name: "A", createdAt: T0, updatedAt: T0 });
      scope.collections.insert({ id: "cb", userId: "bob", name: "B", createdAt: T0, updatedAt: T0 });
    });
    expect(() => repository.withTransaction((scope) => scope.collections.addItem("bob", { id: "i", collectionId: "cb", contentId: "c", position: 0, addedAt: T0 }))).toThrow();
    expect(() => repository.withTransaction((scope) => scope.collections.addItem("alice", { id: "i", collectionId: "cb", contentId: "c", position: 0, addedAt: T0 }))).toThrow();
    repository.withTransaction((scope) => scope.collections.addItem("alice", { id: "i", collectionId: "ca", contentId: "c", position: 0, addedAt: T0 }));
    expect(repository.withTransaction((scope) => scope.collections.listItems("alice", "ca")).map((item) => item.contentId)).toEqual(["c"]);
  });
});

describe("collection edits", () => {
  beforeEach(() => {
    for (const id of ["c1", "c2", "c3"]) {
      insertRow(db, "content", { id, user_id: "alice", source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
    }
    repository.withTransaction((scope) => {
      scope.collections.insert({ id: "ca", userId: "alice", name: "Course", description: "about", createdAt: T0, updatedAt: T0 });
      ["c1", "c2", "c3"].forEach((contentId, index) =>
        scope.collections.addItem("alice", { id: `i${index + 1}`, collectionId: "ca", contentId, position: index, addedAt: T0 + index }),
      );
    });
  });

  const items = (owner = "alice") => repository.withTransaction((scope) => scope.collections.listItems(owner, "ca"));

  it("renames, and clears the description only when asked", () => {
    repository.withTransaction((scope) => scope.collections.update("alice", "ca", { name: "Renamed" }));
    expect(repository.withTransaction((scope) => scope.collections.get("alice", "ca"))).toMatchObject({ name: "Renamed", description: "about" });
    repository.withTransaction((scope) => scope.collections.update("alice", "ca", { description: undefined }));
    expect(repository.withTransaction((scope) => scope.collections.get("alice", "ca"))).toEqual({ id: "ca", userId: "alice", name: "Renamed", createdAt: T0, updatedAt: T0 });
    expect(() => repository.withTransaction((scope) => scope.collections.update("bob", "ca", { name: "Mine" }))).toThrow();
  });

  it("finds and removes items for the owner only", () => {
    expect(repository.withTransaction((scope) => scope.collections.getItem("alice", "i2"))).toEqual({
      id: "i2", collectionId: "ca", contentId: "c2", position: 1, addedAt: T0 + 1,
    });
    expect(repository.withTransaction((scope) => scope.collections.getItem("bob", "i2"))).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.collections.findItem("alice", "ca", "c3"))?.id).toBe("i3");
    expect(repository.withTransaction((scope) => scope.collections.findItem("bob", "ca", "c3"))).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.collections.removeItem("bob", "ca", "i2"))).toBe(false);
    expect(repository.withTransaction((scope) => scope.collections.removeItem("alice", "other", "i2"))).toBe(false);
    expect(repository.withTransaction((scope) => scope.collections.removeItem("alice", "ca", "i2"))).toBe(true);
    expect(items().map((item) => item.id)).toEqual(["i1", "i3"]);
  });

  it("reorders the named items within the slots they hold and rejects repeats or strangers", () => {
    repository.withTransaction((scope) => scope.collections.reorder("alice", "ca", ["i3", "i1", "i2"]));
    expect(items().map((item) => [item.id, item.position])).toEqual([["i3", 0], ["i1", 1], ["i2", 2]]);
    // Only part of the items: they swap the slots 0 and 2, the one not named keeps slot 1.
    repository.withTransaction((scope) => scope.collections.reorder("alice", "ca", ["i2", "i3"]));
    expect(items().map((item) => [item.id, item.position])).toEqual([["i2", 0], ["i1", 1], ["i3", 2]]);
    repository.withTransaction((scope) => scope.collections.reorder("alice", "ca", ["i3", "i1", "i2"]));
    for (const order of [["i1", "i2", "i2"], ["i1", "i2", "i3", "x"], ["i1", "i2", "x"]]) {
      expect(() => repository.withTransaction((scope) => scope.collections.reorder("alice", "ca", order))).toThrow();
    }
    expect(() => repository.withTransaction((scope) => scope.collections.reorder("bob", "ca", ["i1", "i2", "i3"]))).toThrow();
    expect(items().map((item) => item.id)).toEqual(["i3", "i1", "i2"]);
  });

  it("lists visible items without members in the trash, which keep their slot among all items", () => {
    repository.withTransaction((scope) => scope.contents.trash("alice", "c2", T0 + 50));
    const visible = repository.withTransaction((scope) => scope.collections.listVisibleItems("alice", "ca"));
    expect(visible.map((item) => [item.id, item.position])).toEqual([["i1", 0], ["i3", 2]]);
    expect(items().map((item) => item.id)).toEqual(["i1", "i2", "i3"]);
    expect(repository.withTransaction((scope) => scope.collections.listVisibleItems("bob", "ca"))).toEqual([]);
  });

  it("maps Contents to the owner's collections by oldest membership, with empty lists for the rest", () => {
    for (const id of ["m1", "m2", "m3"]) {
      insertRow(db, "content", { id, user_id: "alice", source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
    }
    repository.withTransaction((scope) => {
      scope.collections.insert({ id: "ka", userId: "alice", name: "A", createdAt: T0, updatedAt: T0 });
      scope.collections.insert({ id: "kb", userId: "alice", name: "B", createdAt: T0, updatedAt: T0 });
      scope.collections.addItem("alice", { id: "mi1", collectionId: "kb", contentId: "m1", position: 0, addedAt: T0 });
      scope.collections.addItem("alice", { id: "mi2", collectionId: "ka", contentId: "m1", position: 0, addedAt: T0 + 1 });
      scope.collections.addItem("alice", { id: "mi3", collectionId: "ka", contentId: "m2", position: 1, addedAt: T0 });
    });
    const memberships = repository.withTransaction((scope) => scope.collections.membershipsOf("alice", ["m1", "m2", "m3"]));
    expect(Object.fromEntries(memberships)).toEqual({
      m1: [
        { id: "kb", name: "B", itemId: "mi1" },
        { id: "ka", name: "A", itemId: "mi2" },
      ],
      m2: [{ id: "ka", name: "A", itemId: "mi3" }],
      m3: [],
    });
    expect(Object.fromEntries(repository.withTransaction((scope) => scope.collections.membershipsOf("bob", ["m1"])))).toEqual({ m1: [] });
  });

  it("marks a collection changed, or every collection of a Content, for the owner only", () => {
    insertRow(db, "content", { id: "m1", user_id: "alice", source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
    repository.withTransaction((scope) => {
      for (const id of ["ka", "kb", "kc"]) scope.collections.insert({ id, userId: "alice", name: id, createdAt: T0, updatedAt: T0 });
      scope.collections.addItem("alice", { id: "t1", collectionId: "ka", contentId: "m1", position: 0, addedAt: T0 });
      scope.collections.addItem("alice", { id: "t2", collectionId: "kb", contentId: "m1", position: 0, addedAt: T0 });
    });
    const updated = () => repository.withTransaction((scope) => scope.collections.list("alice").flatMap((collection) => (collection.id === "ca" ? [] : [[collection.id, collection.updatedAt]])));
    repository.withTransaction((scope) => {
      scope.collections.touch("bob", "kc", T0 + 1);
      scope.collections.touchByContent("bob", "m1", T0 + 1);
    });
    expect(updated()).toEqual([["ka", T0], ["kb", T0], ["kc", T0]]);
    repository.withTransaction((scope) => scope.collections.touch("alice", "kc", T0 + 2));
    repository.withTransaction((scope) => scope.collections.touchByContent("alice", "m1", T0 + 3));
    expect(updated()).toEqual([["ka", T0 + 3], ["kb", T0 + 3], ["kc", T0 + 2]]);
  });
});
