import { describe, expect, it } from "vitest";
import { NOTE_SPAN_MAX_SEGMENTS } from "../../../src/shared/defaults.ts";
import { anchorExcerpt, anchorFromBounds, newestFirst, notesBySegment } from "../../../src/web/notes/note-anchor.ts";
import { segment } from "../../fixtures/web/content-data.ts";
import { note } from "../../fixtures/web/note-data.ts";

const SEGMENTS = [segment("s1", 0, 0, 1_000, "先看召回。"), segment("s2", 1, 1_000, 2_000, "再看重排序"), segment("s3", 2, 2_000, 3_000, "最后生成。")];

const bounds = (start: [string, number], end: [string, number]) => ({
  revisionId: "r1",
  start: { segmentId: start[0], offset: start[1] },
  end: { segmentId: end[0], offset: end[1] },
});

describe("anchorFromBounds", () => {
  it("anchors a selection inside one sentence and excerpts it as the server quotes", () => {
    expect(anchorFromBounds(bounds(["s1", 2], ["s1", 4]), SEGMENTS)).toEqual({
      ok: true,
      anchor: { transcriptRevisionId: "r1", startSegmentId: "s1", startOffset: 2, endSegmentId: "s1", endOffset: 4 },
      excerpt: "召回",
    });
  });

  it("joins a span across sentences with the reading separator", () => {
    const result = anchorFromBounds(bounds(["s1", 2], ["s3", 2]), SEGMENTS);
    expect(result).toMatchObject({ ok: true, anchor: { startSegmentId: "s1", endSegmentId: "s3" } });
    // 「再看重排序」 has no closing punctuation, so a space separates it from what follows.
    expect(result.ok && result.excerpt).toBe("召回。再看重排序 最后");
  });

  it("runs a proofread CJK sentence that spans two time slices on without a space, where an unmarked revision keeps one", () => {
    const anchor = { transcriptRevisionId: "r1", startSegmentId: "m1", startOffset: 12, endSegmentId: "m2", endOffset: 6 };
    const texts = ["但这样就等于你同时拒绝了你的老师", "和牛逼的网课，进入恶性循环。"] as const;
    const marked = [segment("m1", 0, 0, 1_000, texts[0], { paragraphStart: true }), segment("m2", 1, 1_000, 2_000, texts[1], { paragraphStart: false })];
    const unmarked = [segment("m1", 0, 0, 1_000, texts[0]), segment("m2", 1, 1_000, 2_000, texts[1])];
    expect(anchorExcerpt(anchor, marked)).toBe("你的老师和牛逼的网课");
    expect(anchorExcerpt(anchor, unmarked)).toBe("你的老师 和牛逼的网课");
  });

  it("puts reversed ends in ordinal order", () => {
    expect(anchorFromBounds(bounds(["s3", 2], ["s1", 2]), SEGMENTS)).toMatchObject({ ok: true, anchor: { startSegmentId: "s1", startOffset: 2, endSegmentId: "s3", endOffset: 2 } });
  });

  it("never splits a surrogate pair: a start moves back onto it, an end past it", () => {
    const emoji = [segment("e1", 0, 0, 1_000, "看😀这里")];
    expect(anchorFromBounds(bounds(["e1", 2], ["e1", 2 + 1]), emoji)).toMatchObject({ ok: true, anchor: { startOffset: 1, endOffset: 3 }, excerpt: "😀" });
  });

  it("refuses spans longer than NOTE_SPAN_MAX_SEGMENTS sentences, counted by ordinals", () => {
    const many = Array.from({ length: NOTE_SPAN_MAX_SEGMENTS + 1 }, (_, index) => segment(`m${index}`, index, index * 1_000, index * 1_000 + 1_000, "一句。"));
    expect(anchorFromBounds(bounds(["m0", 0], [`m${NOTE_SPAN_MAX_SEGMENTS - 1}`, 3]), many).ok).toBe(true);
    expect(anchorFromBounds(bounds(["m0", 0], [`m${NOTE_SPAN_MAX_SEGMENTS}`, 3]), many)).toEqual({ ok: false, reason: "tooLong" });
  });

  it("is unavailable without the sentences' data or with an empty span", () => {
    expect(anchorFromBounds(bounds(["s1", 0], ["s1", 2]), undefined)).toEqual({ ok: false, reason: "unavailable" });
    expect(anchorFromBounds(bounds(["x", 0], ["s1", 2]), SEGMENTS)).toEqual({ ok: false, reason: "unavailable" });
    expect(anchorFromBounds(bounds(["s1", 2], ["s1", 2]), SEGMENTS)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("excerpts nothing for an anchor out of order", () => {
    expect(anchorExcerpt({ transcriptRevisionId: "r1", startSegmentId: "s3", startOffset: 0, endSegmentId: "s1", endOffset: 1 }, SEGMENTS)).toBe("");
  });
});

describe("notesBySegment", () => {
  it("keeps exact offsets, covers whole sentences when approximate and leaves out notes it cannot place", () => {
    const exact = note("n1", { view: { segments: [{ segmentId: "s1", startOffset: 2, endOffset: 5 }, { segmentId: "s2", startOffset: 0, endOffset: 2 }], exact: true } });
    const approximate = note("n2", { view: { segments: [{ segmentId: "s3", startOffset: 1, endOffset: 2 }], exact: false } });
    const unplaced = note("n3", { view: null });
    const placed = notesBySegment([exact, approximate, unplaced], SEGMENTS);
    expect(placed.get("s1")?.map(({ start, end, last }) => ({ start, end, last }))).toEqual([{ start: 2, end: 5, last: false }]);
    expect(placed.get("s2")?.map(({ start, end, last }) => ({ start, end, last }))).toEqual([{ start: 0, end: 2, last: true }]);
    expect(placed.get("s3")?.map(({ note: placedNote, start, end }) => [placedNote.id, start, end])).toEqual([["n2", 0, 5]]);
    expect([...placed.values()].flat().some((item) => item.note.id === "n3")).toBe(false);
  });

  it("orders newest first, a tie going to the larger id", () => {
    expect([note("a", { createdAt: 1 }), note("c", { createdAt: 2 }), note("b", { createdAt: 2 })].sort(newestFirst).map((item) => item.id)).toEqual(["c", "b", "a"]);
  });
});
