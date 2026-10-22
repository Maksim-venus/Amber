import { TOKEN_ESTIMATE_CHARS_PER_TOKEN, TOKEN_ESTIMATE_TOKENS_PER_CJK_CHAR } from "../../shared/defaults.ts";

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * A conservative token estimate for planning inputs against a context window: CJK
 * characters count `TOKEN_ESTIMATE_TOKENS_PER_CJK_CHAR` each, every other character
 * `1 / TOKEN_ESTIMATE_CHARS_PER_TOKEN`. It is an upper bound for budgeting, not a
 * tokenizer, and never depends on the model.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK.test(char)) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(cjk * TOKEN_ESTIMATE_TOKENS_PER_CJK_CHAR + other / TOKEN_ESTIMATE_CHARS_PER_TOKEN);
}
