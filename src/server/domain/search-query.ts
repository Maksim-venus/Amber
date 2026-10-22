import { SEARCH_SHORT_QUERY_MAX_CHARS } from "../../shared/defaults.ts";
import type { SearchRange } from "../../shared/dto/search.ts";

/**
 * Search input as the projection understands it: whitespace-separated terms,
 * every one of which must occur. A term too short for the trigram index switches the whole
 * query to the literal `LIKE` scan; terms are always matched as text, never as syntax.
 */
export interface ParsedSearchQuery {
  terms: string[];
  mode: "fts" | "like";
}

export function parseSearchQuery(input: string): ParsedSearchQuery {
  const terms = [...new Set(input.split(/\s+/u).filter((term) => term !== ""))];
  const short = terms.some((term) => [...term].length <= SEARCH_SHORT_QUERY_MAX_CHARS);
  return { terms, mode: short ? "like" : "fts" };
}

/**
 * The distinct character trigrams of a free-text question, lower-cased and taken within
 * runs of letters and digits only, so punctuation and spacing never form a trigram. Empty
 * when no run reaches three characters.
 */
export function questionTrigrams(question: string): string[] {
  const grams = new Set<string>();
  for (const run of question.toLowerCase().split(/[\s\p{P}\p{S}]+/u)) {
    const chars = [...run];
    for (let i = 0; i + 3 <= chars.length; i += 1) {
      grams.add(chars.slice(i, i + 3).join(""));
    }
  }
  return [...grams];
}

/** Characters shown before the first match. */
const SNIPPET_LEAD_CHARS = 30;
/** Longest snippet, ellipses excluded. */
const SNIPPET_MAX_CHARS = 140;
const ELLIPSIS = "…";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * A short excerpt of `text` around its first match with every occurrence of any term
 * marked: whitespace is collapsed, the window starts `SNIPPET_LEAD_CHARS` before the first
 * match, and cut ends get an ellipsis. Ranges are `[start, end)` UTF-16 offsets into the
 * returned snippet, case-insensitive, merged where they overlap or touch.
 */
export function highlightSnippet(text: string, terms: readonly string[]): { snippet: string; ranges: SearchRange[] } {
  const flat = text.replace(/\s+/gu, " ").trim();
  const pattern = terms.filter((term) => term !== "").map(escapeRegExp).join("|");
  const matches: SearchRange[] = [];
  if (pattern !== "") {
    for (const match of flat.matchAll(new RegExp(pattern, "giu"))) {
      if (match[0].length > 0) {
        matches.push({ start: match.index, end: match.index + match[0].length });
      }
    }
  }
  let start = Math.max(0, (matches[0]?.start ?? 0) - SNIPPET_LEAD_CHARS);
  let end = Math.min(flat.length, start + SNIPPET_MAX_CHARS);
  if (end === flat.length) {
    start = Math.max(0, end - SNIPPET_MAX_CHARS);
  }
  // Never split a surrogate pair.
  if (start > 0 && isLowSurrogate(flat.charCodeAt(start))) start -= 1;
  if (end < flat.length && isLowSurrogate(flat.charCodeAt(end))) end += 1;
  const prefix = start > 0 ? ELLIPSIS : "";
  const snippet = `${prefix}${flat.slice(start, end)}${end < flat.length ? ELLIPSIS : ""}`;
  const shift = prefix.length - start;
  const ranges: SearchRange[] = [];
  for (const match of matches.sort((a, b) => a.start - b.start)) {
    const from = Math.max(match.start, start) + shift;
    const to = Math.min(match.end, end) + shift;
    if (to <= from) continue;
    const last = ranges.at(-1);
    if (last !== undefined && from <= last.end) {
      last.end = Math.max(last.end, to);
    } else {
      ranges.push({ start: from, end: to });
    }
  }
  return { snippet, ranges };
}
