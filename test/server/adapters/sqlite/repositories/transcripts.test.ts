import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import type { TranscriptDraft } from "../../../../../src/server/domain/transcript.ts";
import { insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";
import { lectureTranscripts, type TranscriptFixture } from "../../../../fixtures/transcripts/lecture.ts";

const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;
let lecture: TranscriptFixture;

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
  for (const [id, userId] of [["c", "alice"], ["other", "alice"]] as const) {
    insertRow(db, "content", { id, user_id: userId, source_kind: "bilibili", processing_status: "queued", created_at: T0, updated_at: T0 });
  }
  lecture = lectureTranscripts("c");
  repository.withTransaction((scope) => {
    for (const { revision, segments } of [lecture.platform, lecture.asr, lecture.corrected]) {
      scope.transcripts.insertRevision("alice", revision, segments);
    }
  });
});

describe("transcript segments", () => {
  it("pages a revision by ordinal and keeps each page's lineage", () => {
    const corrected = lecture.corrected;
    const page = (afterOrdinal: number | undefined) =>
      repository.withTransaction((scope) =>
        scope.transcripts.listSegments("alice", corrected.revision.id, { ...(afterOrdinal === undefined ? {} : { afterOrdinal }), limit: 3 }),
      );
    const first = page(undefined);
    expect(first.map((segment) => segment.ordinal)).toEqual([0, 1, 2]);
    expect(first.map((segment) => segment.sourceSegmentIds)).toEqual(corrected.segments.slice(0, 3).map((segment) => segment.sourceSegmentIds));
    const second = page(2);
    expect(second.map((segment) => segment.id)).toEqual([corrected.segments[3]?.id]);
    expect(second[0]?.sourceSegmentIds).toEqual(corrected.segments[3]?.sourceSegmentIds);
    expect(page(3)).toEqual([]);
    // Without a page, the whole revision as before.
    expect(repository.withTransaction((scope) => scope.transcripts.listSegments("alice", corrected.revision.id))).toEqual(corrected.segments);
    expect(repository.withTransaction((scope) => scope.transcripts.listSegments("bob", corrected.revision.id, { limit: 3 }))).toEqual([]);
  });

  it("finds a segment by id for its owner only, with words and sources", () => {
    const asr = lecture.asr.segments[1];
    const corrected = lecture.corrected.segments[1];
    expect(repository.withTransaction((scope) => scope.transcripts.getSegment("alice", String(asr?.id)))).toEqual(asr);
    expect(repository.withTransaction((scope) => scope.transcripts.getSegment("alice", String(corrected?.id)))).toEqual(corrected);
    expect(repository.withTransaction((scope) => scope.transcripts.getSegment("bob", String(asr?.id)))).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.transcripts.getSegment("alice", "missing"))).toBeUndefined();
  });
});

describe("transcript drafts", () => {
  const draft = (id: string, baseRevisionId: string, updatedAt: number, text = "改动"): TranscriptDraft => ({
    id,
    contentId: "c",
    baseRevisionId,
    segments: [{ id: "client-1", startMs: 0, endMs: 1000, text, sourceSegmentIds: [] }],
    updatedAt,
  });

  it("keeps exactly one draft per Content and replaces it whole", () => {
    expect(repository.withTransaction((scope) => scope.transcripts.getDraft("alice", "c"))).toBeUndefined();
    repository.withTransaction((scope) => scope.transcripts.putDraft("alice", draft("d1", lecture.asr.revision.id, T0)));
    const replacement = { ...draft("d2", lecture.corrected.revision.id, T0 + 1, "再改"), segments: [] };
    repository.withTransaction((scope) => scope.transcripts.putDraft("alice", replacement));
    expect(repository.withTransaction((scope) => scope.transcripts.getDraft("alice", "c"))).toEqual(replacement);
    expect(db.prepare("SELECT COUNT(*) AS n FROM transcript_draft").get()).toEqual({ n: 1 });
    expect(repository.withTransaction((scope) => scope.transcripts.getDraft("bob", "c"))).toBeUndefined();
  });

  it("enforces one draft per Content in the schema", () => {
    repository.withTransaction((scope) => scope.transcripts.putDraft("alice", draft("d1", lecture.asr.revision.id, T0)));
    expect(() =>
      insertRow(db, "transcript_draft", { id: "d2", content_id: "c", base_revision_id: lecture.asr.revision.id, segments_json: "[]", updated_at: T0 }),
    ).toThrow(/UNIQUE/);
  });

  it("refuses a base revision of another Content or owner, and another owner's Content", () => {
    expect(() => repository.withTransaction((scope) => scope.transcripts.putDraft("alice", { ...draft("d1", lecture.asr.revision.id, T0), contentId: "other" }))).toThrow();
    expect(() => repository.withTransaction((scope) => scope.transcripts.putDraft("alice", draft("d1", "missing", T0)))).toThrow();
    expect(() => repository.withTransaction((scope) => scope.transcripts.putDraft("bob", draft("d1", lecture.asr.revision.id, T0)))).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM transcript_draft").get()).toEqual({ n: 0 });
  });

  it("deletes the owner's draft only", () => {
    repository.withTransaction((scope) => scope.transcripts.putDraft("alice", draft("d1", lecture.asr.revision.id, T0)));
    expect(repository.withTransaction((scope) => scope.transcripts.deleteDraft("bob", "c"))).toBe(false);
    expect(repository.withTransaction((scope) => scope.transcripts.deleteDraft("alice", "c"))).toBe(true);
    expect(repository.withTransaction((scope) => scope.transcripts.deleteDraft("alice", "c"))).toBe(false);
    expect(repository.withTransaction((scope) => scope.transcripts.getDraft("alice", "c"))).toBeUndefined();
  });
});
