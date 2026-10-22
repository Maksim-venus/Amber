import { describe, expect, it } from "vitest";
import {
  effectiveTerminology,
  normalizeTermKey,
  type TerminologyEntry,
  type TerminologySet,
  validateTerminologyEntries,
} from "../../../src/server/domain/terminology.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { TERMINOLOGY_MAX_ENTRIES, TERMINOLOGY_TERM_MAX_CHARS } from "../../../src/shared/defaults.ts";

function entry(id: string, term: string, ordinal: number, translation?: string): TerminologyEntry {
  return { id, term, ordinal, normalizedKey: normalizeTermKey(term), ...(translation ? { translation } : {}) };
}

function set(scope: TerminologySet["scope"], entries: TerminologyEntry[]): TerminologySet {
  return { id: scope.kind, userId: "u", scope, entries };
}

describe("normalizeTermKey", () => {
  it("applies NFKC, trims, collapses whitespace and folds ASCII case only", () => {
    expect(normalizeTermKey("  Prompt　  Engineering ")).toBe("prompt engineering");
    expect(normalizeTermKey("ＲＡＧ")).toBe("rag");
    expect(normalizeTermKey("生成式软件工程")).toBe("生成式软件工程");
    expect(normalizeTermKey("ÄRGER")).toBe("Ärger");
  });
});

describe("effectiveTerminology", () => {
  it("lets content beat collection beat global and orders by specificity then ordinal", () => {
    const result = effectiveTerminology({
      global: set({ kind: "global" }, [entry("g1", "RAG", 0, "global"), entry("g2", "LLM", 1)]),
      collections: [set({ kind: "collection", collectionId: "c" }, [entry("c2", "Agent", 1), entry("c1", "rag", 0, "collection")])],
      content: set({ kind: "content", contentId: "x" }, [entry("x1", "Rag ", 0, "content")]),
    });
    expect(result.map((item) => item.id)).toEqual(["x1", "c2", "g2"]);
  });

  it("merges several collections in the given order, the earlier one winning", () => {
    const result = effectiveTerminology({
      collections: [
        set({ kind: "collection", collectionId: "first" }, [entry("f1", "Agent", 0, "first")]),
        set({ kind: "collection", collectionId: "second" }, [entry("s1", "agent", 0, "second"), entry("s2", "Harness", 1)]),
      ],
      global: set({ kind: "global" }, [entry("g1", "harness", 0)]),
    });
    expect(result.map((item) => item.id)).toEqual(["f1", "s2"]);
  });

  it("returns nothing when no set applies", () => {
    expect(effectiveTerminology({})).toEqual([]);
  });
});

describe("validateTerminologyEntries", () => {
  const codeOf = (work: () => unknown): string | undefined => {
    try {
      work();
    } catch (error) {
      return isAmberError(error) ? `${error.appError.code}:${error.appError.userMessage}` : String(error);
    }
    return undefined;
  };

  it("numbers entries by position, trims terms and derives their keys", () => {
    expect(validateTerminologyEntries([{ term: "  RAG ", translation: "检索增强生成" }, { term: "Prompt Engineering", rule: "keep_original" }])).toEqual([
      { ordinal: 0, term: "RAG", normalizedKey: "rag", translation: "检索增强生成" },
      { ordinal: 1, term: "Prompt Engineering", normalizedKey: "prompt engineering", rule: "keep_original" },
    ]);
  });

  it("rejects empty, over-long and duplicate terms and over-full sets instead of truncating", () => {
    expect(codeOf(() => validateTerminologyEntries([{ term: "   " }]))).toMatch(/^invalid_request:.*entries\.0\.term/);
    const longest = "术".repeat(TERMINOLOGY_TERM_MAX_CHARS);
    expect(codeOf(() => validateTerminologyEntries([{ term: longest }]))).toBeUndefined();
    expect(codeOf(() => validateTerminologyEntries([{ term: `${longest}语` }]))).toMatch(/^invalid_request:/);
    expect(codeOf(() => validateTerminologyEntries([{ term: "RAG" }, { term: "ｒａｇ" }]))).toMatch(/^invalid_request:.*entries\.1\.term/);
    const full = Array.from({ length: TERMINOLOGY_MAX_ENTRIES }, (_, i) => ({ term: `term ${i}` }));
    expect(validateTerminologyEntries(full)).toHaveLength(TERMINOLOGY_MAX_ENTRIES);
    expect(codeOf(() => validateTerminologyEntries([...full, { term: "one more" }]))).toMatch(/^invalid_request:.*entries/);
  });
});
