import { describe, expect, it } from "vitest";
import { estimateTokens } from "../../../src/server/domain/token-estimate.ts";
import { TOKEN_ESTIMATE_CHARS_PER_TOKEN, TOKEN_ESTIMATE_TOKENS_PER_CJK_CHAR } from "../../../src/shared/defaults.ts";

describe("estimateTokens", () => {
  it("counts CJK characters and other characters at their own rates, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(Math.ceil(4 / TOKEN_ESTIMATE_CHARS_PER_TOKEN));
    expect(estimateTokens("学习")).toBe(Math.ceil(2 * TOKEN_ESTIMATE_TOKENS_PER_CJK_CHAR));
    expect(estimateTokens("RAG 检索")).toBe(Math.ceil(2 * TOKEN_ESTIMATE_TOKENS_PER_CJK_CHAR + 4 / TOKEN_ESTIMATE_CHARS_PER_TOKEN));
    expect(estimateTokens("かなカナ한글")).toBe(Math.ceil(6 * TOKEN_ESTIMATE_TOKENS_PER_CJK_CHAR));
  });

  it("counts characters, not UTF-16 code units", () => {
    expect(estimateTokens("😀😀😀😀")).toBe(Math.ceil(4 / TOKEN_ESTIMATE_CHARS_PER_TOKEN));
  });
});
