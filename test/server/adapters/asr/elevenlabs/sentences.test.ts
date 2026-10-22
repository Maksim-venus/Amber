import { describe, expect, it } from "vitest";
import {
  DEFAULT_SENTENCE_PARAMS,
  mergeSentences,
  sentenceParamsFor,
  unitsOf,
  ZH_SENTENCE_PARAMS,
  type MergeWord,
  type SentenceParams,
} from "../../../../../src/server/adapters/asr/elevenlabs/sentences.ts";

/** Words spaced `stepMs` apart, each `lengthMs` long, starting at `startMs`. */
function words(texts: readonly string[], options: { startMs?: number; stepMs?: number; lengthMs?: number; spaced?: boolean } = {}): MergeWord[] {
  const { startMs = 0, stepMs = 300, lengthMs = 250, spaced = true } = options;
  return texts.map((text, index) => ({
    text,
    startMs: startMs + index * stepMs,
    endMs: startMs + index * stepMs + lengthMs,
    spaceBefore: spaced && index > 0,
  }));
}

describe("sentence parameters", () => {
  it("stay inside the fixed ranges: pause 300–1500 ms, duration 15–60 s, 20–80 characters or 15–60 words", () => {
    for (const params of [ZH_SENTENCE_PARAMS, DEFAULT_SENTENCE_PARAMS]) {
      expect(params.pauseMs).toBeGreaterThanOrEqual(300);
      expect(params.pauseMs).toBeLessThanOrEqual(1500);
      expect(params.maxDurationMs).toBeGreaterThanOrEqual(15_000);
      expect(params.maxDurationMs).toBeLessThanOrEqual(60_000);
    }
    expect(ZH_SENTENCE_PARAMS.unit).toBe("chars");
    expect(ZH_SENTENCE_PARAMS.maxUnits).toBeGreaterThanOrEqual(20);
    expect(ZH_SENTENCE_PARAMS.maxUnits).toBeLessThanOrEqual(80);
    expect(DEFAULT_SENTENCE_PARAMS.unit).toBe("words");
    expect(DEFAULT_SENTENCE_PARAMS.maxUnits).toBeGreaterThanOrEqual(15);
    expect(DEFAULT_SENTENCE_PARAMS.maxUnits).toBeLessThanOrEqual(60);
  });

  it("are chosen by the main language only: Chinese gets its own set, everything else the default", () => {
    expect(sentenceParamsFor("zh")).toBe(ZH_SENTENCE_PARAMS);
    expect(sentenceParamsFor("zh-Hans-CN")).toBe(ZH_SENTENCE_PARAMS);
    for (const language of ["en", "en-US", "ja", "und", "yue"]) {
      expect(sentenceParamsFor(language)).toBe(DEFAULT_SENTENCE_PARAMS);
    }
  });

  it("count Chinese by characters (a Latin word inside as one) and others by words", () => {
    expect(unitsOf("生成式", ZH_SENTENCE_PARAMS)).toBe(3);
    expect(unitsOf("代码。", ZH_SENTENCE_PARAMS)).toBe(2);
    expect(unitsOf("Claude", ZH_SENTENCE_PARAMS)).toBe(1);
    expect(unitsOf("，", ZH_SENTENCE_PARAMS)).toBe(0);
    expect(unitsOf("specification", DEFAULT_SENTENCE_PARAMS)).toBe(1);
    expect(unitsOf("—", DEFAULT_SENTENCE_PARAMS)).toBe(0);
  });
});

describe("mergeSentences", () => {
  const params: SentenceParams = { name: "default", pauseMs: 800, maxDurationMs: 20_000, maxUnits: 6, unit: "words" };

  it("ends a sentence at sentence-final punctuation first", () => {
    const result = mergeSentences(words(["One", "two.", "Three", "four?", "Five!"]), params);
    expect(result.map((sentence) => sentence.text)).toEqual(["One two.", "Three four?", "Five!"]);
  });

  it("does not end at a lone full stop followed by a lowercase word in spaced text", () => {
    const result = mergeSentences(words(["Use", "e.g.", "this.", "Next"]), params);
    expect(result.map((sentence) => sentence.text)).toEqual(["Use e.g. this.", "Next"]);
  });

  it("ends a sentence at a pause of at least pauseMs when there is no punctuation", () => {
    const first = words(["so", "that", "is", "it"]);
    const second = words(["and", "then"], { startMs: (first.at(-1) as MergeWord).endMs + 800 });
    const result = mergeSentences([...first, ...second], params);
    expect(result.map((sentence) => sentence.text)).toEqual(["so that is it", "and then"]);
    const shorter = words(["and", "then"], { startMs: (first.at(-1) as MergeWord).endMs + 799 });
    expect(mergeSentences([...first, ...shorter], params)).toHaveLength(1);
  });

  it("cuts a sentence that would outgrow the unit limit at its last clause punctuation", () => {
    const result = mergeSentences(words(["a", "b,", "c", "d", "e", "f", "g", "h"]), params);
    expect(result.map((sentence) => sentence.text)).toEqual(["a b,", "c d e f g h"]);
  });

  it("cuts right before the overflowing word when there is no clause punctuation", () => {
    const result = mergeSentences(words(["a", "b", "c", "d", "e", "f", "g", "h"]), params);
    expect(result.map((sentence) => sentence.text)).toEqual(["a b c d e f", "g h"]);
  });

  it("cuts a sentence that would outgrow the duration limit", () => {
    const slow = mergeSentences(words(["a", "b", "c", "d"], { stepMs: 8_000, lengthMs: 7_500 }), { ...params, pauseMs: 1_500 });
    expect(slow.map((sentence) => sentence.text)).toEqual(["a b", "c d"]);
  });

  it("joins Chinese words without spaces and Latin words with the spacing the service gave", () => {
    const tokens: MergeWord[] = [
      { text: "我们", startMs: 0, endMs: 400, spaceBefore: false },
      { text: "用", startMs: 450, endMs: 600, spaceBefore: false },
      { text: "Claude", startMs: 650, endMs: 900, spaceBefore: true },
      { text: "来", startMs: 950, endMs: 1100, spaceBefore: true },
      { text: "写。", startMs: 1150, endMs: 1400, spaceBefore: false },
    ];
    expect(mergeSentences(tokens, ZH_SENTENCE_PARAMS)).toEqual([{ startMs: 0, endMs: 1400, text: "我们用 Claude 来写。" }]);
  });

  it("keeps every sentence ordered, non-overlapping and longer than zero", () => {
    const tokens: MergeWord[] = [
      { text: "A.", startMs: 100, endMs: 100, spaceBefore: false },
      { text: "B.", startMs: 90, endMs: 300, spaceBefore: true },
      { text: "C.", startMs: 300, endMs: 300, spaceBefore: true },
    ];
    const result = mergeSentences(tokens, params);
    expect(result).toEqual([
      { startMs: 100, endMs: 101, text: "A." },
      { startMs: 101, endMs: 300, text: "B." },
      { startMs: 300, endMs: 301, text: "C." },
    ]);
  });

  it("carries the speaker of the sentence's first word and returns nothing for no words", () => {
    const tokens = words(["Hi."]).map((word) => ({ ...word, speakerId: "speaker_0" }));
    expect(mergeSentences(tokens, params)[0]?.speakerId).toBe("speaker_0");
    expect(mergeSentences([], params)).toEqual([]);
  });

  it("gives the same output for the same input", () => {
    const tokens = words(["a", "b,", "c", "d.", "e", "f", "g", "h", "i", "j", "k"]);
    expect(JSON.stringify(mergeSentences(tokens, params))).toBe(JSON.stringify(mergeSentences(tokens, params)));
  });
});
