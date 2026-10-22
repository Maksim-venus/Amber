import { describe, expect, it } from "vitest";
import { highlightSnippet, parseSearchQuery, questionTrigrams } from "../../../src/server/domain/search-query.ts";
import { SEARCH_SHORT_QUERY_MAX_CHARS } from "../../../src/shared/defaults.ts";

const marked = (result: { snippet: string; ranges: Array<{ start: number; end: number }> }) =>
  result.ranges.map((range) => result.snippet.slice(range.start, range.end));

describe("parseSearchQuery", () => {
  it("splits on whitespace, drops duplicates and picks FTS when every term is long enough", () => {
    expect(parseSearchQuery("  gradient   descent gradient ")).toEqual({ terms: ["gradient", "descent"], mode: "fts" });
  });

  it("falls back to the LIKE scan when any term is at most SEARCH_SHORT_QUERY_MAX_CHARS code points", () => {
    expect(SEARCH_SHORT_QUERY_MAX_CHARS).toBe(2);
    expect(parseSearchQuery("检索").mode).toBe("like");
    expect(parseSearchQuery("检索增强 ai").mode).toBe("like");
    expect(parseSearchQuery("检索增").mode).toBe("fts");
    // An astral character counts once, not as two UTF-16 units.
    expect(parseSearchQuery("😀😀").mode).toBe("like");
  });
});

describe("questionTrigrams", () => {
  it("takes trigrams inside letter / digit runs only, lower-cased and de-duplicated", () => {
    expect(questionTrigrams("RAG 是什么？")).toEqual(["rag", "是什么"]);
    expect(questionTrigrams("ab, cd")).toEqual([]);
    expect(questionTrigrams("aaaa")).toEqual(["aaa"]);
  });
});

describe("highlightSnippet", () => {
  it("marks every occurrence of every term case-insensitively with UTF-16 offsets", () => {
    const result = highlightSnippet("Gradient descent: the gradient points uphill", ["gradient"]);
    expect(result.snippet).toBe("Gradient descent: the gradient points uphill");
    expect(marked(result)).toEqual(["Gradient", "gradient"]);
  });

  it("merges overlapping and adjacent matches", () => {
    const result = highlightSnippet("检索增强生成", ["检索", "增强", "索增"]);
    expect(result.ranges).toEqual([{ start: 0, end: 4 }]);
  });

  it("cuts a long text around the first match with ellipses and keeps ranges inside the snippet", () => {
    const text = `${"前文".repeat(100)}关键词${"后文".repeat(100)}`;
    const result = highlightSnippet(text, ["关键词"]);
    expect(result.snippet.startsWith("…")).toBe(true);
    expect(result.snippet.endsWith("…")).toBe(true);
    expect(marked(result)).toEqual(["关键词"]);
    expect(result.snippet.length).toBeLessThan(text.length);
  });

  it("collapses whitespace and treats terms literally, not as patterns", () => {
    const result = highlightSnippet("a.b  axb\n(c)", ["a.b", "(c)"]);
    expect(result.snippet).toBe("a.b axb (c)");
    expect(marked(result)).toEqual(["a.b", "(c)"]);
  });

  it("never splits a surrogate pair at a window edge", () => {
    const text = `${"😀".repeat(80)}目标${"😀".repeat(80)}`;
    const { snippet } = highlightSnippet(text, ["目标"]);
    expect(snippet).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  });
});
