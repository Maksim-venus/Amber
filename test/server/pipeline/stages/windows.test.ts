import { describe, expect, it } from "vitest";
import { estimateTokens } from "../../../../src/server/domain/token-estimate.ts";
import type { TranscriptSegment } from "../../../../src/server/domain/transcript.ts";
import { planSentenceWindows } from "../../../../src/server/pipeline/stages/windows.ts";
import { CONTEXT_SAFETY_RATIO, LLM_MAX_OUTPUT_TOKENS_DEFAULT } from "../../../../src/shared/defaults.ts";
import type { SegmentId } from "../../../../src/shared/ids.ts";

const modelRef = { providerProfileId: "p", modelId: "m" };

function segments(texts: readonly string[]): TranscriptSegment[] {
  return texts.map((text, ordinal) => ({
    id: `seg${ordinal}` as SegmentId,
    revisionId: "r",
    ordinal,
    startMs: ordinal * 1000,
    endMs: ordinal * 1000 + 900,
    text,
    sourceSegmentIds: [],
  }));
}

describe("planSentenceWindows", () => {
  it("fills windows greedily with global aliases, one physical line per sentence", () => {
    const input = segments(["甲甲甲甲", "乙\r\n乙", "丙丙丙丙", "丁丁丁丁"]);
    const line = estimateTokens("[[s1]] 甲甲甲甲\n");
    const fixedTokens = 40;
    const contextWindowTokens = Math.ceil((fixedTokens + 2.5 * line + 10) / CONTEXT_SAFETY_RATIO);
    const windows = planSentenceWindows(input, { fixedTokens, limits: { contextWindowTokens, maxOutputTokens: 10 }, modelRef });
    expect(windows.map((window) => [window.offset, window.lines])).toEqual([
      [0, ["[[s1]] 甲甲甲甲", "[[s2]] 乙 乙"]],
      [2, ["[[s3]] 丙丙丙丙", "[[s4]] 丁丁丁丁"]],
    ]);
    expect(windows[1]?.segments.map((segment) => segment.id)).toEqual(["seg2", "seg3"]);
  });

  it("puts everything in one window when it fits, reserving the default output when none is declared", () => {
    const windows = planSentenceWindows(segments(["一", "二"]), { fixedTokens: 10, limits: { contextWindowTokens: LLM_MAX_OUTPUT_TOKENS_DEFAULT * 4 }, modelRef });
    expect(windows).toHaveLength(1);
    // Without a declared maxOutputTokens the default is reserved, which a window that small cannot hold.
    expect(() => planSentenceWindows(segments(["一"]), { fixedTokens: 10, limits: { contextWindowTokens: LLM_MAX_OUTPUT_TOKENS_DEFAULT }, modelRef })).toThrow();
  });

  it("refuses an unknown window, a budget with no room and a sentence larger than the budget", () => {
    const code = (fn: () => unknown): unknown => {
      try {
        fn();
      } catch (error) {
        return (error as { appError?: { code?: string; details?: unknown } }).appError;
      }
      return undefined;
    };
    expect(code(() => planSentenceWindows(segments(["一"]), { fixedTokens: 1, limits: {}, modelRef }))).toMatchObject({
      code: "llm_capability.context_window_unknown",
      details: modelRef,
    });
    expect(code(() => planSentenceWindows(segments(["一"]), { fixedTokens: 1000, limits: { contextWindowTokens: 1000, maxOutputTokens: 1 }, modelRef }))).toMatchObject({
      code: "llm_capability.context_length",
    });
    expect(code(() => planSentenceWindows(segments(["长".repeat(500)]), { fixedTokens: 1, limits: { contextWindowTokens: 200, maxOutputTokens: 1 }, modelRef }))).toMatchObject({
      code: "llm_capability.context_length",
    });
  });
});
