import { afterEach, describe, expect, it } from "vitest";
import type { TranscriptRevision, TranscriptSegment } from "../../../src/server/domain/transcript.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { lectureTranscripts } from "../../fixtures/transcripts/lecture.ts";
import { BOB, createHarness, createLocalContent, createTaskOfKind, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

/** A Content whose primary is the ASR original, with the corrected revision stored beside it. */
function setup() {
  const h = createHarness();
  open.push(h);
  const contentId = createLocalContent(h);
  const fixture = lectureTranscripts(contentId);
  h.repository.withTransaction((scope) => {
    for (const { revision, segments } of [fixture.asr, fixture.corrected]) {
      scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
    }
    scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, fixture.asr.revision.id, 2);
  });
  /** Stores a translation of `parent` in `language` and makes it the language's current one. */
  const translate = (parent: { revision: TranscriptRevision; segments: TranscriptSegment[] }, language: string, createdAt: number): string => {
    const id = h.newId();
    const segments: TranscriptSegment[] = parent.segments.map((source, ordinal) => ({
      id: h.newId() as SegmentId,
      revisionId: id,
      ordinal,
      startMs: source.startMs,
      endMs: source.endMs,
      text: `${language}: ${source.text}`,
      sourceSegmentIds: [source.id],
    }));
    h.repository.withTransaction((scope) => {
      scope.transcripts.insertRevision(
        LOCAL.userId,
        {
          id,
          contentId,
          kind: "translated",
          parentRevisionId: parent.revision.id,
          language,
          timingFidelity: "segment_only",
          generation: { kind: "llm", modelRef: { providerProfileId: "p", modelId: "m", providerNameSnapshot: "relay", modelDisplaySnapshot: "m" }, promptRef: { id: "translate.subtitles", version: 1 }, promptSnapshot: "<prompt>" },
          segmentCount: segments.length,
          createdAt,
        },
        segments,
      );
      scope.translations.setCurrent(LOCAL.userId, contentId, language, id, h.newId());
    });
    return id;
  };
  return { h, contentId, fixture, translate };
}

describe("TranslationService", () => {
  it("lists each language with its current translation and that language's history, oldest first", () => {
    const { h, contentId, fixture, translate } = setup();
    expect(h.translations.get(LOCAL, contentId)).toEqual({ translations: [], activeTasks: [] });
    const enOld = translate(fixture.asr, "en", 10);
    const ja = translate(fixture.asr, "ja", 11);
    const enNew = translate(fixture.asr, "en", 12);
    const dto = h.translations.get(LOCAL, contentId);
    expect(dto.translations.map((entry) => [entry.targetLanguage, entry.current?.id, entry.revisions.map((revision) => revision.id), entry.stale])).toEqual([
      ["en", enNew, [enOld, enNew], false],
      ["ja", ja, [ja], false],
    ]);
    expect(dto.translations[0]?.current).toMatchObject({ kind: "translated", parentRevisionId: fixture.asr.revision.id, timingFidelity: "segment_only" });
    expect(dto.translations[0]).not.toHaveProperty("staleReason");
  });

  it("marks a translation stale once its parent is no longer the primary", () => {
    const { h, contentId, fixture, translate } = setup();
    translate(fixture.asr, "en", 10);
    translate(fixture.corrected, "ja", 11);
    h.repository.withTransaction((scope) => scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, fixture.corrected.revision.id, 3));
    const byLanguage = Object.fromEntries(h.translations.get(LOCAL, contentId).translations.map((entry) => [entry.targetLanguage, entry]));
    expect(byLanguage.en).toMatchObject({ stale: true, staleReason: "transcript_changed" });
    expect(byLanguage.ja).toMatchObject({ stale: false });
  });

  it("reports unfinished translate Tasks with their languages and hides foreign Contents", () => {
    const { h, contentId, fixture } = setup();
    const taskId = createTaskOfKind(h, "translate", { targetLanguages: ["en", "ja"], baseRevisionId: fixture.asr.revision.id }, { contentId });
    createTaskOfKind(h, "regenerate_chapters", { baseRevisionId: fixture.asr.revision.id, outputLanguage: "zh-CN" }, { contentId });
    expect(h.translations.get(LOCAL, contentId).activeTasks).toEqual([{ taskId, targetLanguages: ["en", "ja"] }]);
    h.tasks.cancel(LOCAL, taskId);
    expect(h.translations.get(LOCAL, contentId).activeTasks).toEqual([]);
    expect(() => h.translations.get(BOB, contentId)).toThrow(/not found/);
  });
});
