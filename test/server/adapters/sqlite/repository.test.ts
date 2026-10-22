import { monotonicFactory } from "ulid";
import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../src/server/adapters/sqlite/repository.ts";
import type { Content } from "../../../../src/server/domain/content.ts";
import { isAmberError } from "../../../../src/server/domain/errors.ts";
import type { MediaAsset } from "../../../../src/server/domain/media-asset.ts";
import type { TranscriptSegment } from "../../../../src/server/domain/transcript.ts";
import { lectureTranscripts } from "../../../fixtures/transcripts/lecture.ts";
import { countRows, openTempDatabase } from "../../../tools/sqlite.ts";

const nextId = monotonicFactory();
const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;

function content(userId: string, extra: Partial<Content> = {}): Content {
  return { id: nextId(), userId, source: { kind: "local" }, processingStatus: "queued", createdAt: T0, updatedAt: T0, ...extra };
}

function codeOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : `non-AmberError: ${String(error)}`;
  }
  return undefined;
}

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  repository.withTransaction((scope) => {
    for (const id of ["alice", "bob"]) scope.users.insert({ id, role: "user", status: "active", createdAt: T0 });
  });
});

describe("withTransaction", () => {
  it("commits the callback's writes and returns its value", () => {
    const created = content("alice", { title: "Lecture 1" });
    expect(repository.withTransaction((scope) => (scope.contents.insert(created), created.id))).toBe(created.id);
    expect(repository.withTransaction((scope) => scope.contents.get("alice", created.id))).toEqual(created);
  });

  it("rolls every write back when the callback throws", () => {
    expect(() =>
      repository.withTransaction((scope) => {
        scope.contents.insert(content("alice"));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(countRows(db, "content")).toBe(0);
  });

  it("refuses an async callback and rolls back what it wrote synchronously", () => {
    expect(() =>
      // @ts-expect-error a transaction cannot stay open across an await
      repository.withTransaction(async (scope) => {
        scope.contents.insert(content("alice"));
      }),
    ).toThrow(/synchronous/);
    expect(countRows(db, "content")).toBe(0);
  });
});

describe("owner scope", () => {
  it("never shows one user's rows to another; foreign ids behave like unknown ids", () => {
    const own = content("alice");
    repository.withTransaction((scope) => {
      scope.contents.insert(own);
      scope.collections.insert({ id: "course", userId: "alice", name: "Course", createdAt: T0, updatedAt: T0 });
    });
    repository.withTransaction((scope) => {
      expect(scope.contents.get("bob", own.id)).toBeUndefined();
      expect(scope.contents.list("bob")).toEqual([]);
      expect(scope.collections.get("bob", "course")).toBeUndefined();
      expect(scope.collections.listItems("bob", "course")).toEqual([]);
      expect(scope.contents.delete("bob", own.id)).toBe(false);
      expect(scope.collections.delete("bob", "course")).toBe(false);
    });
    expect(codeOf(() => repository.withTransaction((scope) => scope.collections.addItem("bob", { id: nextId(), collectionId: "course", contentId: own.id, position: 0, addedAt: T0 })))).toBe("not_found");
    expect(codeOf(() => repository.withTransaction((scope) => scope.contents.setPrimaryTranscript("bob", own.id, undefined, T0)))).toBe("not_found");
    expect(repository.withTransaction((scope) => scope.contents.get("alice", own.id))).toEqual(own);
  });

  it("finds platform content by its canonical identity only for its owner", () => {
    const source = { kind: "bilibili" as const, platformContentId: "BV1xx", platformPartId: "cid-1", sourceUrl: "https://www.bilibili.com/video/BV1xx?p=1" };
    const created = content("alice", { source });
    repository.withTransaction((scope) => scope.contents.insert(created));
    repository.withTransaction((scope) => {
      expect(scope.contents.findByPlatformIdentity("alice", source)).toEqual(created);
      expect(scope.contents.findByPlatformIdentity("alice", { ...source, platformPartId: "cid-2" })).toBeUndefined();
      expect(scope.contents.findByPlatformIdentity("bob", source)).toBeUndefined();
      expect(scope.contents.findByPlatformIdentity("alice", { kind: "local" })).toBeUndefined();
    });
  });

  it("scopes media assets and collection items to their owner", () => {
    const own = content("alice");
    const asset: MediaAsset = {
      id: nextId(), userId: "alice", contentId: own.id, kind: "external_local", storageRef: "/media/lecture.mp4",
      displayName: "lecture.mp4", mimeType: "video/mp4", sizeBytes: 10, fingerprint: "sha256:ab",
      availability: "available", retentionPolicy: "never_delete", createdAt: T0,
    };
    repository.withTransaction((scope) => {
      scope.contents.insert(own);
      scope.mediaAssets.insert(asset);
      scope.collections.insert({ id: "course", userId: "alice", name: "Course", createdAt: T0, updatedAt: T0 });
      scope.collections.addItem("alice", { id: "item", collectionId: "course", contentId: own.id, position: 0, addedAt: T0 });
    });
    repository.withTransaction((scope) => {
      expect(scope.mediaAssets.get("alice", asset.id)).toEqual(asset);
      expect(scope.mediaAssets.listByContent("alice", own.id)).toEqual([asset]);
      expect(scope.mediaAssets.get("bob", asset.id)).toBeUndefined();
      expect(scope.mediaAssets.listByContent("bob", own.id)).toEqual([]);
      expect(scope.collections.listItems("alice", "course")).toEqual([{ id: "item", collectionId: "course", contentId: own.id, position: 0, addedAt: T0 }]);
    });
  });
});

describe("transcripts", () => {
  it("round-trips the three-kind, two-generation fixture with words and lineage", () => {
    const own = content("alice");
    const fixture = lectureTranscripts(own.id);
    repository.withTransaction((scope) => {
      scope.contents.insert(own);
      for (const part of [fixture.platform, fixture.asr, fixture.corrected]) {
        scope.transcripts.insertRevision("alice", part.revision, part.segments);
      }
      scope.contents.setPrimaryTranscript("alice", own.id, fixture.corrected.revision.id, T0 + 10);
    });
    repository.withTransaction((scope) => {
      expect(scope.transcripts.listRevisions("alice", own.id)).toEqual([fixture.platform.revision, fixture.asr.revision, fixture.corrected.revision]);
      for (const part of [fixture.platform, fixture.asr, fixture.corrected]) {
        expect(scope.transcripts.listSegments("alice", part.revision.id)).toEqual(part.segments);
      }
      expect(scope.contents.get("alice", own.id)?.primaryTranscriptRevisionId).toBe(fixture.corrected.revision.id);
      expect(scope.transcripts.getRevision("bob", fixture.asr.revision.id)).toBeUndefined();
      expect(scope.transcripts.listSegments("bob", fixture.asr.revision.id)).toEqual([]);
      expect(scope.transcripts.listRevisions("bob", own.id)).toEqual([]);
    });
  });

  it("refuses zero-length sentences, sources outside the parent and foreign owners, writing nothing", () => {
    const own = content("alice");
    const fixture = lectureTranscripts(own.id);
    repository.withTransaction((scope) => {
      scope.contents.insert(own);
      scope.transcripts.insertRevision("alice", fixture.asr.revision, fixture.asr.segments);
    });
    const zeroLength = fixture.platform.segments.map((segment, index): TranscriptSegment =>
      index === 1 ? { ...segment, endMs: segment.startMs } : segment,
    );
    expect(codeOf(() => repository.withTransaction((scope) => scope.transcripts.insertRevision("alice", fixture.platform.revision, zeroLength)))).toBe("internal");
    // A corrected sentence must point into its own parent revision.
    const foreignSource = fixture.corrected.segments.map((segment): TranscriptSegment => ({ ...segment, sourceSegmentIds: [fixture.platform.segments[0]?.id ?? segment.id] }));
    expect(codeOf(() => repository.withTransaction((scope) => scope.transcripts.insertRevision("alice", fixture.corrected.revision, foreignSource)))).toBe("internal");
    expect(codeOf(() => repository.withTransaction((scope) => scope.transcripts.insertRevision("bob", fixture.platform.revision, fixture.platform.segments)))).toBe("not_found");
    expect(countRows(db, "transcript_revision")).toBe(1);
  });

  it("only points the primary transcript at a revision of the same Content", () => {
    const first = content("alice");
    const second = content("alice");
    const fixture = lectureTranscripts(first.id);
    repository.withTransaction((scope) => {
      scope.contents.insert(first);
      scope.contents.insert(second);
      scope.transcripts.insertRevision("alice", fixture.platform.revision, fixture.platform.segments);
    });
    expect(codeOf(() => repository.withTransaction((scope) => scope.contents.setPrimaryTranscript("alice", second.id, fixture.platform.revision.id, T0)))).toBe("not_found");
  });
});

describe("users", () => {
  it("inserts, reads and deletes users", () => {
    repository.withTransaction((scope) => {
      expect(scope.users.get("alice")).toEqual({ id: "alice", role: "user", status: "active", createdAt: T0 });
      expect(scope.users.delete("alice")).toBe(true);
      expect(scope.users.get("alice")).toBeUndefined();
    });
  });
});
