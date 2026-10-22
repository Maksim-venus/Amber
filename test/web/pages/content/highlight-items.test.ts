import { describe, expect, it } from "vitest";
import { HIGHLIGHT_THRESHOLD_DEFAULT } from "../../../../src/shared/defaults.ts";
import type { HighlightItemDto } from "../../../../src/shared/dto/highlight.ts";
import { visibleHighlights } from "../../../../src/web/pages/content/highlight-items.ts";

const item = (segmentId: string, score: number, startMs: number): HighlightItemDto => ({
  segmentId,
  score,
  text: `理由 ${segmentId}`,
  segmentText: `原句 ${segmentId}`,
  startMs,
  endMs: startMs + 1_000,
});

describe("visibleHighlights", () => {
  it("the threshold filter lets through scores at or above it, in time order", () => {
    const items = [item("late", 95, 90_000), item("low", 40, 10_000), item("edge", HIGHLIGHT_THRESHOLD_DEFAULT, 50_000), item("early", 81, 0)];
    expect(visibleHighlights(items, HIGHLIGHT_THRESHOLD_DEFAULT).map((entry) => entry.segmentId)).toEqual(["early", "edge", "late"]);
    expect(visibleHighlights(items, 0).map((entry) => entry.segmentId)).toEqual(["early", "low", "edge", "late"]);
    expect(visibleHighlights(items, 100)).toEqual([]);
  });
});
