import { TERMINOLOGY_MAX_ENTRIES, TERMINOLOGY_TERM_MAX_CHARS } from "../../shared/defaults.ts";
import { amberError, type AmberError } from "./errors.ts";

export interface TerminologyEntry {
  id: string;
  /** User-controlled order inside the set; the stable basis for truncation and conflict resolution. */
  ordinal: number;
  term: string;
  normalizedKey: string;
  translation?: string;
  rule?: "keep_original";
}

export type TerminologyScope =
  | { kind: "global" }
  | { kind: "collection"; collectionId: string }
  | { kind: "content"; contentId: string };

export interface TerminologySet {
  id: string;
  userId: string;
  scope: TerminologyScope;
  entries: TerminologyEntry[];
}

/**
 * NFKC, trim, whitespace collapse and ASCII-only case folding. Deliberately no Chinese
 * normalization, translation or semantic merging.
 */
export function normalizeTermKey(term: string): string {
  return term
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * Effective terminology shared by ASR, proofreading and translation: the union of the
 * three scopes merged by `normalizedKey`, where content beats collection beats global.
 * A Content in several collections passes their sets in ascending order of when it was
 * added to each, and the earlier collection wins. The result is ordered by
 * scope specificity, then `ordinal`, so later truncation to a provider limit is
 * deterministic.
 */
export function effectiveTerminology(sets: {
  content?: TerminologySet;
  collections?: readonly TerminologySet[];
  global?: TerminologySet;
}): TerminologyEntry[] {
  const seen = new Set<string>();
  const result: TerminologyEntry[] = [];
  for (const set of [sets.content, ...(sets.collections ?? []), sets.global]) {
    if (set === undefined) {
      continue;
    }
    const ordered = [...set.entries].sort((a, b) => a.ordinal - b.ordinal);
    for (const entry of ordered) {
      if (!seen.has(entry.normalizedKey)) {
        seen.add(entry.normalizedKey);
        result.push(entry);
      }
    }
  }
  return result;
}

/** One entry as the user writes it; position in the list is its `ordinal`. */
export interface TerminologyEntryInput {
  term: string;
  translation?: string;
  rule?: "keep_original";
}

/**
 * Validates a whole set as written and returns its entries without ids:
 * terms are trimmed and must be non-empty and at most `TERMINOLOGY_TERM_MAX_CHARS`
 * characters, the set at most `TERMINOLOGY_MAX_ENTRIES` entries, and no two entries may
 * share a `normalizedKey`. A violation is `invalid_request`; nothing is ever truncated,
 * only ASR submission trims to provider limits.
 */
export function validateTerminologyEntries(entries: readonly TerminologyEntryInput[]): Array<Omit<TerminologyEntry, "id">> {
  if (entries.length > TERMINOLOGY_MAX_ENTRIES) {
    throw invalid("entries");
  }
  const seen = new Set<string>();
  return entries.map((input, ordinal) => {
    const term = input.term.trim();
    if (term === "" || [...term].length > TERMINOLOGY_TERM_MAX_CHARS) {
      throw invalid(`entries.${ordinal}.term`);
    }
    const normalizedKey = normalizeTermKey(term);
    if (seen.has(normalizedKey)) {
      throw invalid(`entries.${ordinal}.term`);
    }
    seen.add(normalizedKey);
    return {
      ordinal,
      term,
      normalizedKey,
      ...(input.translation === undefined ? {} : { translation: input.translation }),
      ...(input.rule === undefined ? {} : { rule: input.rule }),
    };
  });
}

function invalid(detail: string): AmberError {
  return amberError("invalid_request", "terminology set rejected", { params: { detail } });
}

/**
 * The `{{terms_section}}` of the built-in prompts: the effective entries under a
 * heading, one per line, or empty when there are none.
 */
export function termsSection(entries: readonly TerminologyEntry[]): string {
  if (entries.length === 0) {
    return "";
  }
  const lines = entries.map((entry) => {
    const translated = entry.translation === undefined ? entry.term : `${entry.term} = ${entry.translation}`;
    return entry.rule === "keep_original" ? `${translated}（保持原文）` : translated;
  });
  return ["【术语表】", ...lines].join("\n");
}
