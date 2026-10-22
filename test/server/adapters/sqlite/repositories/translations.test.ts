import { monotonicFactory } from "ulid";
import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../../../../src/server/domain/transcript.ts";
import type { SegmentId } from "../../../../../src/shared/ids.ts";
import { lectureTranscripts } from "../../../../fixtures/transcripts/lecture.ts";
import { insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
const newId = monotonicFactory();
let db: SqliteConnection;
let repository: SqliteRepository;
let parent: { revision: TranscriptRevision; segments: TranscriptSegment[] };

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
  insertRow(db, "content", { id: "c", user_id: "alice", source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
  parent = lectureTranscripts("c").asr;
  repository.withTransaction((scope) => scope.transcripts.insertRevision("alice", parent.revision, parent.segments));
});

/** A `translated` revision of the ASR original in `language`, stored. */
function translated(language: string): string {
  const id = newId();
  const segments: TranscriptSegment[] = parent.segments.map((source, ordinal) => ({
    id: newId() as SegmentId,
    revisionId: id,
    ordinal,
    startMs: source.startMs,
    endMs: source.endMs,
    text: `${language}: ${source.text}`,
    sourceSegmentIds: [source.id],
  }));
  const revision: TranscriptRevision = {
    id,
    contentId: "c",
    kind: "translated",
    parentRevisionId: parent.revision.id,
    language,
    timingFidelity: "segment_only",
    generation: { kind: "llm", modelRef: { providerProfileId: "p", modelId: "m", providerNameSnapshot: "relay", modelDisplaySnapshot: "m" }, promptRef: { id: "translate.subtitles", version: 1 }, promptSnapshot: "<prompt>" },
    segmentCount: segments.length,
    createdAt: T0,
  };
  repository.withTransaction((scope) => scope.transcripts.insertRevision("alice", revision, segments));
  return id;
}

describe("translation repository", () => {
  it("creates the language's artifact on first use, then moves its current pointer", () => {
    const first = translated("en");
    repository.withTransaction((scope) => scope.translations.setCurrent("alice", "c", "en", first, "ta1"));
    expect(repository.withTransaction((scope) => scope.translations.getArtifact("alice", "c", "en"))).toEqual({
      id: "ta1",
      contentId: "c",
      targetLanguage: "en",
      currentRevisionId: first,
    });
    const second = translated("en");
    repository.withTransaction((scope) => scope.translations.setCurrent("alice", "c", "en", second, "ta-unused"));
    expect(repository.withTransaction((scope) => scope.translations.getArtifact("alice", "c", "en"))).toMatchObject({ id: "ta1", currentRevisionId: second });
    expect(db.prepare("SELECT id FROM translation_artifact").all()).toEqual([{ id: "ta1" }]);
  });

  it("lists the Content's artifacts by target language", () => {
    repository.withTransaction((scope) => {
      scope.translations.setCurrent("alice", "c", "ja", translated("ja"), "ta-ja");
      scope.translations.setCurrent("alice", "c", "en", translated("en"), "ta-en");
    });
    expect(repository.withTransaction((scope) => scope.translations.listArtifacts("alice", "c")).map((artifact) => artifact.targetLanguage)).toEqual(["en", "ja"]);
  });

  it("refuses a revision that is not a translation in that language and keeps owners apart", () => {
    const en = translated("en");
    expect(() => repository.withTransaction((scope) => scope.translations.setCurrent("alice", "c", "en", parent.revision.id, "x"))).toThrow(/not found/);
    expect(() => repository.withTransaction((scope) => scope.translations.setCurrent("alice", "c", "ja", en, "x"))).toThrow(/not found/);
    expect(() => repository.withTransaction((scope) => scope.translations.setCurrent("bob", "c", "en", en, "x"))).toThrow(/not found/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM translation_artifact").get()).toEqual({ n: 0 });

    repository.withTransaction((scope) => scope.translations.setCurrent("alice", "c", "en", en, "ta1"));
    expect(repository.withTransaction((scope) => scope.translations.getArtifact("bob", "c", "en"))).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.translations.listArtifacts("bob", "c"))).toEqual([]);
  });
});
