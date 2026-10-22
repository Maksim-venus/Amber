import { describe, expect, it } from "vitest";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { assertFits, carryAllowance, planSummary, transcriptBudget, type PlannedSentence } from "../../../src/server/domain/rollup.ts";
import { estimateTokens } from "../../../src/server/domain/token-estimate.ts";
import { CONTEXT_SAFETY_RATIO, LLM_MAX_OUTPUT_TOKENS_DEFAULT, ROLLUP_CARRY_BUDGET_CHARS } from "../../../src/shared/defaults.ts";

const modelRef = { providerProfileId: "p", modelId: "m" };

/** `count` sentences of `chars` CJK characters each, one second apart. */
function sentences(count: number, chars = 10): PlannedSentence[] {
  return Array.from({ length: count }, (_, i) => ({ line: `[[s${i + 1}]] ${"字".repeat(chars)}`, startMs: i * 1000 }));
}

/** A window whose input room is exactly `room` tokens with a 10-token output reservation. */
function limitsFor(room: number) {
  return { contextWindowTokens: Math.ceil((room + 10) / CONTEXT_SAFETY_RATIO), maxOutputTokens: 10 };
}

function codeOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : String(error);
  }
  return undefined;
}

describe("budgets", () => {
  it("is the window times CONTEXT_SAFETY_RATIO minus the fixed part and the output reservation", () => {
    expect(transcriptBudget({ contextWindowTokens: 10_000, maxOutputTokens: 500 }, "固定")).toBe(Math.floor(10_000 * CONTEXT_SAFETY_RATIO) - 500 - estimateTokens("固定"));
    expect(transcriptBudget({ contextWindowTokens: 100_000 }, "")).toBe(Math.floor(100_000 * CONTEXT_SAFETY_RATIO) - LLM_MAX_OUTPUT_TOKENS_DEFAULT);
    expect(transcriptBudget({}, "")).toBeUndefined();
    expect([...carryAllowance()]).toHaveLength(ROLLUP_CARRY_BUDGET_CHARS);
  });

  it("assertFits rejects a prompt over the room with context_length and checks nothing for an unknown window", () => {
    const limits = limitsFor(estimateTokens("字".repeat(50)));
    expect(codeOf(() => assertFits(limits, "字".repeat(50)))).toBeUndefined();
    expect(codeOf(() => assertFits(limits, "字".repeat(80)))).toBe("llm_capability.context_length");
    expect(codeOf(() => assertFits({}, "字".repeat(100_000)))).toBeUndefined();
  });
});

describe("planSummary", () => {
  const cost = estimateTokens(`${sentences(1)[0]?.line}\n`);

  it("summarizes in one call when the whole transcript fits", () => {
    expect(planSummary({ sentences: sentences(5), singleFixed: "", partialFixed: "", limits: limitsFor(cost * 5), modelRef })).toEqual({ mode: "single" });
  });

  it("rolls greedily by sentence without chapters", () => {
    const plan = planSummary({ sentences: sentences(7), singleFixed: "", partialFixed: "", limits: limitsFor(cost * 3), modelRef });
    expect(plan).toEqual({
      mode: "rolling",
      byChapters: false,
      groups: [
        { first: 0, count: 3 },
        { first: 3, count: 3 },
        { first: 6, count: 1 },
      ],
    });
  });

  it("rolls by chapter, sentences before the first chapter going to it, splitting a long chapter evenly without crossing chapters", () => {
    // Chapters start at 2 s, 4 s and 9 s: sentences 0..3 (the first two precede it) go to the
    // first, 4..8 to the second (over budget, so two even runs), 9 to the third.
    const plan = planSummary({ sentences: sentences(10), chapterStarts: [2000, 4000, 9000], singleFixed: "", partialFixed: "", limits: limitsFor(cost * 4), modelRef });
    expect(plan).toEqual({
      mode: "rolling",
      byChapters: true,
      groups: [
        { first: 0, count: 4, chapterIndex: 0 },
        { first: 4, count: 3, chapterIndex: 1 },
        { first: 7, count: 2, chapterIndex: 1 },
        { first: 9, count: 1, chapterIndex: 2 },
      ],
    });
  });

  it("with an unknown window rolls by chapter without checks, and without chapters fails with context_window_unknown", () => {
    const plan = planSummary({ sentences: sentences(4, 5000), chapterStarts: [0, 2000], singleFixed: "", partialFixed: "", limits: {}, modelRef });
    expect(plan).toEqual({
      mode: "rolling",
      byChapters: true,
      groups: [
        { first: 0, count: 2, chapterIndex: 0 },
        { first: 2, count: 2, chapterIndex: 1 },
      ],
    });
    let details: unknown;
    try {
      planSummary({ sentences: sentences(4), singleFixed: "", partialFixed: "", limits: {}, modelRef });
    } catch (error) {
      details = isAmberError(error) ? [error.appError.code, error.appError.details] : error;
    }
    expect(details).toEqual(["llm_capability.context_window_unknown", { providerProfileId: "p", modelId: "m" }]);
  });

  it("fails with context_length when no budget is left or one sentence alone is over it", () => {
    expect(codeOf(() => planSummary({ sentences: sentences(3), singleFixed: "字".repeat(500), partialFixed: "", limits: limitsFor(100), modelRef }))).toBe(
      "llm_capability.context_length",
    );
    expect(codeOf(() => planSummary({ sentences: [...sentences(3), { line: "字".repeat(400), startMs: 9000 }], singleFixed: "", partialFixed: "", limits: limitsFor(cost * 3), modelRef }))).toBe(
      "llm_capability.context_length",
    );
    expect(codeOf(() => planSummary({ sentences: sentences(20), singleFixed: "", partialFixed: "字".repeat(200), limits: limitsFor(cost * 3), modelRef }))).toBe(
      "llm_capability.context_length",
    );
  });
});
