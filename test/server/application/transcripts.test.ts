import { afterEach, describe, expect, it } from "vitest";
import type { TranscriptRevision, TranscriptSegment } from "../../../src/server/domain/transcript.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { createHarness, createLocalContent, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

/** An ASR original made primary, optionally with paragraph marks. */
function seed(h: Harness, contentId: string, count: number, paragraphStarts?: readonly boolean[]): { revision: TranscriptRevision; segments: TranscriptSegment[] } {
  const revisionId = h.newId();
  const segments: TranscriptSegment[] = Array.from({ length: count }, (_, ordinal) => ({
    id: h.newId() as SegmentId,
    revisionId,
    ordinal,
    startMs: ordinal * 1000,
    endMs: ordinal * 1000 + 900,
    text: `第${ordinal + 1}句`,
    ...(paragraphStarts === undefined ? {} : { paragraphStart: paragraphStarts[ordinal] as boolean }),
    sourceSegmentIds: [],
  }));
  const revision: TranscriptRevision = {
    id: revisionId,
    contentId,
    kind: "asr",
    language: "zh-CN",
    timingFidelity: "exact_words",
    generation: { kind: "asr", asrProfileId: "asr", modelId: "scribe" },
    segmentCount: count,
    createdAt: 1,
  };
  h.repository.withTransaction((scope) => {
    scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
    scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, revisionId, 2);
  });
  return { revision, segments };
}

describe("TranscriptService draft commit", () => {
  it("carries the base's paragraph marks into the manual revision: merges keep the first source's, splits open once, new sentences never", () => {
    const h = createHarness();
    open.push(h);
    const contentId = createLocalContent(h);
    const base = seed(h, contentId, 5, [true, false, true, false, true]);
    const ids = base.segments.map((segment) => segment.id);
    const sentence = (startMs: number, sourceSegmentIds: string[]) => ({ startMs, endMs: startMs + 500, text: "改", sourceSegmentIds });
    h.transcripts.putDraft(LOCAL, contentId, {
      baseRevisionId: base.revision.id,
      segments: [
        sentence(0, [ids[0] as string]),
        sentence(1000, [ids[1] as string, ids[2] as string]),
        sentence(3000, [ids[3] as string]),
        sentence(4000, [ids[4] as string]),
        sentence(4500, [ids[4] as string]),
        sentence(5000, []),
      ],
    });
    const committed = h.transcripts.commitDraft(LOCAL, contentId, { expectedPrimaryRevisionId: base.revision.id });
    const segments = h.repository.withTransaction((scope) => scope.transcripts.listSegments(LOCAL.userId, committed.id));
    expect(segments.map((segment) => segment.paragraphStart)).toEqual([true, false, false, true, false, false]);
    expect(h.transcripts.segments(LOCAL, committed.id, { limit: 10 }).items.map((item) => item.paragraphStart)).toEqual([true, false, false, true, false, false]);
  });

  it("adds no marks when the base has none", () => {
    const h = createHarness();
    open.push(h);
    const contentId = createLocalContent(h);
    const base = seed(h, contentId, 2);
    h.transcripts.putDraft(LOCAL, contentId, {
      baseRevisionId: base.revision.id,
      segments: base.segments.map((segment) => ({ startMs: segment.startMs, endMs: segment.endMs, text: segment.text, sourceSegmentIds: [segment.id] })),
    });
    const committed = h.transcripts.commitDraft(LOCAL, contentId, { expectedPrimaryRevisionId: base.revision.id });
    const items = h.transcripts.segments(LOCAL, committed.id, { limit: 10 }).items;
    expect(items.map((item) => item.paragraphStart)).toEqual([undefined, undefined]);
    expect(items.every((item) => !("paragraphStart" in item))).toBe(true);
  });
});
