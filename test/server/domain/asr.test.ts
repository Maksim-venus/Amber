import { describe, expect, it } from "vitest";
import { ASR_KEYTERMS_MAX } from "../../../src/shared/defaults.ts";
import { assignWordsToSentences, truncateTerminologyForAsr } from "../../../src/server/domain/asr.ts";
import { normalizeTermKey, type TerminologyEntry } from "../../../src/server/domain/terminology.ts";
import type { TranscriptWord } from "../../../src/server/domain/transcript.ts";

const entry = (ordinal: number, term: string): TerminologyEntry => ({
  id: `term-${ordinal}`,
  ordinal,
  term,
  normalizedKey: normalizeTermKey(term),
});

// The limits ElevenLabs declares in its speech-to-text documentation.
const ELEVENLABS_LIMITS = { maxTerminologyEntries: 1000, maxTerminologyTermChars: 49, maxTerminologyWords: 5 };

describe("truncateTerminologyForAsr", () => {
  it("gives byte-identical output for the same terminology", () => {
    const entries = Array.from({ length: 1500 }, (_, index) => entry(index, `term ${index}`));
    const first = JSON.stringify(truncateTerminologyForAsr(entries, ELEVENLABS_LIMITS, ASR_KEYTERMS_MAX));
    const second = JSON.stringify(truncateTerminologyForAsr(entries, ELEVENLABS_LIMITS, ASR_KEYTERMS_MAX));
    expect(second).toBe(first);
  });

  it("keeps at most the smaller of the named limit and the provider's entry limit, in order", () => {
    const entries = Array.from({ length: 1500 }, (_, index) => entry(index, `term ${index}`));
    const truncated = truncateTerminologyForAsr(entries, ELEVENLABS_LIMITS, ASR_KEYTERMS_MAX);
    expect(truncated.entries).toHaveLength(Math.min(ASR_KEYTERMS_MAX, ELEVENLABS_LIMITS.maxTerminologyEntries));
    expect(truncated.entries).toEqual(entries.slice(0, truncated.entries.length));
    expect(truncated).toMatchObject({ droppedTooLong: 0, cutOff: 1500 - truncated.entries.length });

    const tighter = truncateTerminologyForAsr(entries, { ...ELEVENLABS_LIMITS, maxTerminologyEntries: 3 }, ASR_KEYTERMS_MAX);
    expect(tighter.entries.map((kept) => kept.term)).toEqual(["term 0", "term 1", "term 2"]);
    expect(truncateTerminologyForAsr(entries, {}, 2).entries).toHaveLength(2);
  });

  it("drops terms over the character or word limit and blank terms, counting them", () => {
    const entries = [
      entry(0, "生成式软件工程"),
      entry(1, "x".repeat(49)),
      entry(2, "x".repeat(50)),
      entry(3, "one two three four five"),
      entry(4, "one two three four five six"),
      entry(5, "   "),
      entry(6, "Claude Opus 4.5"),
    ];
    const truncated = truncateTerminologyForAsr(entries, ELEVENLABS_LIMITS, ASR_KEYTERMS_MAX);
    expect(truncated.entries.map((kept) => kept.ordinal)).toEqual([0, 1, 3, 6]);
    expect(truncated).toMatchObject({ droppedTooLong: 3, cutOff: 0 });
  });

  it("counts characters by code point, not UTF-16 unit", () => {
    const astral = "𝔸".repeat(49);
    expect(truncateTerminologyForAsr([entry(0, astral)], ELEVENLABS_LIMITS, ASR_KEYTERMS_MAX).entries).toHaveLength(1);
  });

  it("drops dropped-for-length terms before applying the entry limit", () => {
    const entries = [entry(0, "x".repeat(60)), entry(1, "a"), entry(2, "b"), entry(3, "c")];
    const truncated = truncateTerminologyForAsr(entries, { ...ELEVENLABS_LIMITS, maxTerminologyEntries: 2 }, ASR_KEYTERMS_MAX);
    expect(truncated.entries.map((kept) => kept.term)).toEqual(["a", "b"]);
    expect(truncated).toMatchObject({ droppedTooLong: 1, cutOff: 1 });
  });
});

describe("assignWordsToSentences", () => {
  const word = (text: string, startMs: number, endMs: number): TranscriptWord => ({ text, startMs, endMs });
  // Two sentences with a gap between 1000 and 2000.
  const sentences = [
    { startMs: 0, endMs: 1000 },
    { startMs: 2000, endMs: 3000 },
  ];
  const texts = (assigned: TranscriptWord[][]): string[][] => assigned.map((words) => words.map((assignedWord) => assignedWord.text));

  it("puts a word in the sentence containing its midpoint", () => {
    // Starts in the first sentence but its midpoint (2100) lies in the second.
    expect(texts(assignWordsToSentences(sentences, [word("a", 100, 400), word("b", 900, 3300)]))).toEqual([["a"], ["b"]]);
  });

  it("uses startMs as the midpoint of a zero-length word", () => {
    expect(texts(assignWordsToSentences(sentences, [word("z", 2500, 2500)]))).toEqual([[], ["z"]]);
  });

  it("treats sentence spans as right-open", () => {
    // Midpoint exactly 1000 belongs to [1000, 2000), not to [0, 1000).
    expect(texts(assignWordsToSentences([{ startMs: 0, endMs: 1000 }, { startMs: 1000, endMs: 2000 }], [word("edge", 1000, 1000)]))).toEqual([
      [],
      ["edge"],
    ]);
  });

  it("assigns a midpoint in a gap to the sentence with the nearer boundary, the earlier one on a tie", () => {
    const assigned = assignWordsToSentences(sentences, [word("near-first", 1200, 1200), word("near-second", 1800, 1800), word("tie", 1500, 1500)]);
    expect(texts(assigned)).toEqual([["near-first", "tie"], ["near-second"]]);
  });

  it("assigns words before the first sentence to it and after the last sentence to that one", () => {
    const shifted = [
      { startMs: 500, endMs: 1000 },
      { startMs: 2000, endMs: 3000 },
    ];
    expect(texts(assignWordsToSentences(shifted, [word("early", 0, 200), word("late", 3500, 4000)]))).toEqual([["early"], ["late"]]);
  });

  it("keeps input order within each sentence and returns an empty list per sentence without words", () => {
    expect(texts(assignWordsToSentences(sentences, [word("x", 10, 20), word("y", 30, 40)]))).toEqual([["x", "y"], []]);
    expect(assignWordsToSentences([], [word("w", 0, 10)])).toEqual([]);
  });
});
