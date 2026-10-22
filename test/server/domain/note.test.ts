import { describe, expect, it } from "vitest";
import { NOTE_SPAN_MAX_SEGMENTS } from "../../../src/shared/defaults.ts";
import { noteAnchorProblem, noteQuote, splitsSurrogatePair, type NoteAnchor } from "../../../src/server/domain/note.ts";

const revision = { id: "r", kind: "corrected" as const };
const sentence = (id: string, ordinal: number, text: string, revisionId = "r") => ({ id, revisionId, ordinal, text });
const A = sentence("a", 0, "ABCDE");
const B = sentence("b", 1, "第二句。");
const EMOJI = sentence("e", 2, "x😀y");
const anchor = (overrides: Partial<NoteAnchor> = {}): NoteAnchor => ({
  transcriptRevisionId: "r",
  startSegmentId: "a",
  startOffset: 1,
  endSegmentId: "a",
  endOffset: 3,
  ...overrides,
});

describe("noteAnchorProblem", () => {
  it("accepts a span inside one sentence and one across sentences", () => {
    expect(noteAnchorProblem(anchor(), revision, A, A)).toBeUndefined();
    expect(noteAnchorProblem(anchor({ endSegmentId: "b", endOffset: 4 }), revision, A, B)).toBeUndefined();
    // Whole sentence, and a cross-sentence span starting at the very beginning.
    expect(noteAnchorProblem(anchor({ startOffset: 0, endOffset: 5 }), revision, A, A)).toBeUndefined();
    expect(noteAnchorProblem(anchor({ startOffset: 0, endSegmentId: "b", endOffset: 1 }), revision, A, B)).toBeUndefined();
  });

  it("refuses translations, foreign or missing sentences and reversed order", () => {
    expect(noteAnchorProblem(anchor(), { id: "r", kind: "translated" }, A, A)).toBe("anchor");
    expect(noteAnchorProblem(anchor({ transcriptRevisionId: "other" }), revision, A, A)).toBe("anchor");
    expect(noteAnchorProblem(anchor(), revision, undefined, A)).toBe("anchor");
    expect(noteAnchorProblem(anchor(), revision, A, undefined)).toBe("anchor");
    expect(noteAnchorProblem(anchor(), revision, sentence("a", 0, "ABCDE", "other"), A)).toBe("anchor");
    expect(noteAnchorProblem(anchor(), revision, A, sentence("a", 0, "ABCDE", "other"))).toBe("anchor");
    expect(noteAnchorProblem(anchor({ startSegmentId: "b", endSegmentId: "a" }), revision, B, A)).toBe("anchor");
  });

  it("refuses offsets outside the sentences, empty spans and non-integers", () => {
    expect(noteAnchorProblem(anchor({ startOffset: -1 }), revision, A, A)).toBe("anchor");
    expect(noteAnchorProblem(anchor({ startOffset: 5, endSegmentId: "b", endOffset: 1 }), revision, A, B)).toBe("anchor");
    expect(noteAnchorProblem(anchor({ endOffset: 6 }), revision, A, A)).toBe("anchor");
    expect(noteAnchorProblem(anchor({ startOffset: 0, endSegmentId: "b", endOffset: 0 }), revision, A, B)).toBe("anchor");
    expect(noteAnchorProblem(anchor({ startOffset: 3, endOffset: 3 }), revision, A, A)).toBe("anchor");
    expect(noteAnchorProblem(anchor({ startOffset: 3, endOffset: 2 }), revision, A, A)).toBe("anchor");
    expect(noteAnchorProblem(anchor({ startOffset: 1.5 }), revision, A, A)).toBe("anchor");
  });

  it("refuses an offset between the halves of a surrogate pair", () => {
    const on = (startOffset: number, endOffset: number) =>
      noteAnchorProblem(anchor({ startSegmentId: "e", endSegmentId: "e", startOffset, endOffset }), revision, EMOJI, EMOJI);
    expect(on(1, 3)).toBeUndefined();
    expect(on(2, 4)).toBe("anchor");
    expect(on(0, 2)).toBe("anchor");
    expect(splitsSurrogatePair("x😀y", 2)).toBe(true);
    expect(splitsSurrogatePair("x😀y", 1)).toBe(false);
    expect(splitsSurrogatePair("x😀y", 3)).toBe(false);
  });

  it("refuses more than NOTE_SPAN_MAX_SEGMENTS sentences as a span problem", () => {
    const last = sentence("z", NOTE_SPAN_MAX_SEGMENTS - 1, "end");
    const beyond = sentence("z", NOTE_SPAN_MAX_SEGMENTS, "end");
    expect(noteAnchorProblem(anchor({ endSegmentId: "z", endOffset: 3 }), revision, A, last)).toBeUndefined();
    expect(noteAnchorProblem(anchor({ endSegmentId: "z", endOffset: 3 }), revision, A, beyond)).toBe("span");
  });
});

describe("noteQuote", () => {
  it("is the plain slice within one sentence", () => {
    expect(noteQuote([{ text: "ABCDE" }], 1, 3)).toBe("BC");
    expect(noteQuote([{ text: "ABCDE" }], 0, 5)).toBe("ABCDE");
  });

  it("joins the start's tail, whole middle sentences and the end's head with reading separators", () => {
    expect(noteQuote([{ text: "Hello world." }, { text: "Second one." }, { text: "Third here." }], 6, 5)).toBe("world. Second one. Third");
    // Full-width punctuation runs on without a space; separators come from the full sentences, not the cut pieces.
    expect(noteQuote([{ text: "大家好。" }, { text: "今天讲检索。" }], 2, 2)).toBe("好。今天");
    expect(noteQuote([{ text: "没有标点" }, { text: "也没有" }], 2, 1)).toBe("标点 也");
  });

  it("joins CJK across a bare sentence end directly only when the revision carries paragraph marks", () => {
    const texts = ["拒绝了你的老师", "和牛逼的网课，"];
    expect(noteQuote(texts.map((text, index) => ({ text, paragraphStart: index === 0 })), 5, 3)).toBe("老师和牛逼");
    expect(noteQuote(texts.map((text) => ({ text })), 5, 3)).toBe("老师 和牛逼");
    // Marked or not, a CJK–English boundary keeps its space.
    expect(noteQuote([{ text: "我们用", paragraphStart: true }, { text: "React 写", paragraphStart: false }], 2, 5)).toBe("用 React");
  });
});
