import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import type { PendingFileDelete } from "../../../../../src/server/domain/runtime-support.ts";
import { openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;

function entry(id: string, extra: Partial<PendingFileDelete> = {}): PendingFileDelete {
  return { id, store: "cache", rootPath: "/cache/media", storageRef: `media/${id}.mp4`, attempts: 0, nextAttemptAt: T0, createdAt: T0, ...extra };
}

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
});

describe("pending file delete repository", () => {
  it("round-trips a row; registering the same root and ref again keeps the first", () => {
    repository.withTransaction((scope) => {
      scope.pendingFileDeletes.insert(entry("a", { expectedSizeBytes: 9, userId: "u" }));
      scope.pendingFileDeletes.insert(entry("again", { storageRef: "media/a.mp4", expectedSizeBytes: 1 }));
      // Another root or store is another file.
      scope.pendingFileDeletes.insert(entry("b", { storageRef: "media/a.mp4", rootPath: "/other/media" }));
      scope.pendingFileDeletes.insert(entry("c", { store: "data", rootPath: "/data", storageRef: "assets/u/c/x" }));
    });
    const cache = repository.withTransaction((scope) => scope.pendingFileDeletes.listByStore("cache"));
    expect(cache).toEqual([
      { id: "a", store: "cache", rootPath: "/cache/media", storageRef: "media/a.mp4", expectedSizeBytes: 9, userId: "u", attempts: 0, nextAttemptAt: T0, createdAt: T0 },
      { id: "b", store: "cache", rootPath: "/other/media", storageRef: "media/a.mp4", attempts: 0, nextAttemptAt: T0, createdAt: T0 },
    ]);
    expect(repository.withTransaction((scope) => scope.pendingFileDeletes.listByStore("data")).map((row) => row.id)).toEqual(["c"]);
  });

  it("lists what is due earliest first, reschedules, deletes and reports the earliest due time", () => {
    repository.withTransaction((scope) => {
      scope.pendingFileDeletes.insert(entry("late", { nextAttemptAt: T0 + 50 }));
      scope.pendingFileDeletes.insert(entry("early", { nextAttemptAt: T0 + 10 }));
      scope.pendingFileDeletes.insert(entry("now"));
    });
    const due = (now: number, limit = 10) => repository.withTransaction((scope) => scope.pendingFileDeletes.listDue(now, limit)).map((row) => row.id);
    expect(due(T0 + 10)).toEqual(["now", "early"]);
    expect(due(T0 + 50, 1)).toEqual(["now"]);
    repository.withTransaction((scope) => scope.pendingFileDeletes.reschedule("now", 1, T0 + 100, "EBUSY"));
    expect(repository.withTransaction((scope) => scope.pendingFileDeletes.listByStore("cache")).find((row) => row.id === "now")).toMatchObject({
      attempts: 1,
      nextAttemptAt: T0 + 100,
      lastError: "EBUSY",
    });
    repository.withTransaction((scope) => scope.pendingFileDeletes.delete("early"));
    expect(repository.withTransaction((scope) => scope.pendingFileDeletes.earliestAttemptAt())).toBe(T0 + 50);
    repository.withTransaction((scope) => {
      scope.pendingFileDeletes.delete("late");
      scope.pendingFileDeletes.delete("now");
    });
    expect(repository.withTransaction((scope) => scope.pendingFileDeletes.earliestAttemptAt())).toBeUndefined();
  });
});
