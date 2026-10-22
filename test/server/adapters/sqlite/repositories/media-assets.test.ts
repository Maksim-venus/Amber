import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import { isAmberError } from "../../../../../src/server/domain/errors.ts";
import type { MediaAsset } from "../../../../../src/server/domain/media-asset.ts";
import { insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;

function asset(id: string, userId: string, extra: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id,
    userId,
    contentId: `c-${userId}`,
    kind: "managed_upload",
    storageRef: `assets/${userId}/c-${userId}/${id}`,
    mimeType: "video/mp4",
    sizeBytes: 10,
    availability: "available",
    retentionPolicy: "keep",
    createdAt: T0,
    ...extra,
  };
}

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) {
    insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
    insertRow(db, "content", { id: `c-${id}`, user_id: id, source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
    insertRow(db, "task", {
      id: `t-${id}`, user_id: id, content_id: `c-${id}`, kind: "process_content", request_json: "{}", status_projection: "queued", created_at: T0,
    });
  }
});

describe("media asset repository", () => {
  it("lists Task-scoped assets and finds assets by fingerprint, per owner", () => {
    repository.withTransaction((scope) => {
      scope.mediaAssets.insert(asset("orig", "alice", { fingerprint: "sha256:aa" }));
      scope.mediaAssets.insert(asset("dup", "alice", { fingerprint: "sha256:aa", createdAt: T0 + 1 }));
      scope.mediaAssets.insert(asset("audio", "alice", { kind: "extracted_audio", taskId: "t-alice", retentionPolicy: "ephemeral", mimeType: "audio/flac" }));
      scope.mediaAssets.insert(asset("bobs", "bob", { fingerprint: "sha256:aa" }));
    });
    const found = repository.withTransaction((scope) => scope.mediaAssets.findByFingerprint("alice", "sha256:aa"));
    expect(found.map((a) => a.id)).toEqual(["orig", "dup"]);
    expect(repository.withTransaction((scope) => scope.mediaAssets.listByTask("alice", "t-alice")).map((a) => a.id)).toEqual(["audio"]);
    expect(repository.withTransaction((scope) => scope.mediaAssets.listByTask("bob", "t-alice"))).toEqual([]);
  });

  it("updates mutable fields and deletes only the owner's rows", () => {
    repository.withTransaction((scope) => scope.mediaAssets.insert(asset("a1", "alice")));
    repository.withTransaction((scope) =>
      scope.mediaAssets.update("alice", { ...asset("a1", "alice"), availability: "missing", durationMs: 3000, fingerprint: "sha256:bb" }),
    );
    expect(repository.withTransaction((scope) => scope.mediaAssets.get("alice", "a1"))).toMatchObject({
      availability: "missing",
      durationMs: 3000,
      fingerprint: "sha256:bb",
    });
    let error: unknown;
    try {
      repository.withTransaction((scope) => scope.mediaAssets.update("bob", asset("a1", "alice")));
    } catch (caught) {
      error = caught;
    }
    expect(isAmberError(error) && error.appError.code).toBe("not_found");
    expect(repository.withTransaction((scope) => scope.mediaAssets.delete("bob", "a1"))).toBe(false);
    expect(repository.withTransaction((scope) => scope.mediaAssets.delete("alice", "a1"))).toBe(true);
    expect(repository.withTransaction((scope) => scope.mediaAssets.get("alice", "a1"))).toBeUndefined();
  });

  it("finds every user's cache rows at one storage ref in any availability, and nothing else", () => {
    const cache = (id: string, userId: string, extra: Partial<MediaAsset> = {}) =>
      asset(id, userId, { kind: "platform_cache", storageRef: "media/Lecture.mp4", retentionPolicy: "evictable", ...extra });
    repository.withTransaction((scope) => {
      scope.mediaAssets.insert(cache("old", "alice", { availability: "evicted" }));
      scope.mediaAssets.insert(cache("new", "alice", { createdAt: T0 + 1 }));
      scope.mediaAssets.insert(cache("bobs", "bob", { createdAt: T0 + 2 }));
      scope.mediaAssets.insert(cache("other", "alice", { storageRef: "media/Lecture (2).mp4" }));
      // Same text in a non-cache row is not a cache file.
      scope.mediaAssets.insert(asset("upload", "alice", { storageRef: "media/Lecture.mp4" }));
    });
    const found = repository.withTransaction((scope) => scope.mediaAssets.listCachesByStorageRefUnscoped("media/Lecture.mp4"));
    expect(found.map((a) => [a.id, a.availability])).toEqual([["old", "evicted"], ["new", "available"], ["bobs", "available"]]);
    expect(repository.withTransaction((scope) => scope.mediaAssets.listCachesByStorageRefUnscoped("media/lecture.mp4"))).toEqual([]);
  });

  it("lists one owner's caches in any availability, oldest first, and nothing else", () => {
    const cache = (id: string, userId: string, extra: Partial<MediaAsset> = {}) =>
      asset(id, userId, { kind: "platform_cache", storageRef: `media/${id}.mp4`, retentionPolicy: "evictable", ...extra });
    repository.withTransaction((scope) => {
      scope.mediaAssets.insert(cache("gone", "alice", { availability: "evicted", createdAt: T0 + 2 }));
      scope.mediaAssets.insert(cache("here", "alice", { createdAt: T0 + 1 }));
      scope.mediaAssets.insert(cache("bobs", "bob"));
      scope.mediaAssets.insert(asset("upload", "alice"));
    });
    expect(repository.withTransaction((scope) => scope.mediaAssets.listCachesOfUser("alice")).map((a) => a.id)).toEqual(["here", "gone"]);
  });
});
