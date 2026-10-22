import type { HighlightItemDto } from "../../../shared/dto/highlight.ts";

/** The highlights the threshold slider lets through: score at or above it, in time order. */
export function visibleHighlights(items: readonly HighlightItemDto[], threshold: number): HighlightItemDto[] {
  return items.filter((item) => item.score >= threshold).sort((a, b) => a.startMs - b.startMs);
}
