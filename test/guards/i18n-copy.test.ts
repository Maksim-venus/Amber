import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./lib/files.ts";
import { fixtureRoot } from "./lib/fixture.ts";
import { hardcodedCopy, looksLikeCopy } from "./lib/i18n-copy.ts";

describe("no hardcoded copy in src/web", () => {
  it("finds no violation in the repository", () => {
    expect(hardcodedCopy(REPO_ROOT)).toEqual([]);
  });

  it("rejects the counter-example fixture and honours exemptions and the allowlist", () => {
    const allowlist = [{ file: "src/web/pages/good-page.tsx", text: "Allowed copy, kept on purpose.", reason: "fixture" }];
    expect(hardcodedCopy(fixtureRoot("i18n-copy"), allowlist)).toEqual([
      { file: "src/web/pages/bad-page.tsx", rule: "hardcoded-copy", line: 4 },
      { file: "src/web/pages/bad-page.tsx", rule: "hardcoded-copy", line: 5 },
      { file: "src/web/pages/bad-page.tsx", rule: "hardcoded-copy", line: 6 },
      { file: "src/web/pages/bad-page.tsx", rule: "hardcoded-copy", line: 9 },
      { file: "src/web/pages/bad-page.tsx", rule: "hardcoded-copy", line: 14 },
    ]);
  });

  it("classifies copy by CJK or punctuated Latin phrases", () => {
    expect(looksLikeCopy("总结")).toBe(true);
    expect(looksLikeCopy("Try again, later")).toBe(true);
    expect(looksLikeCopy("Saved successfully.")).toBe(true);
    expect(looksLikeCopy("Save")).toBe(false);
    expect(looksLikeCopy("flex items-center gap-2")).toBe(false);
    expect(looksLikeCopy("Ctrl+K")).toBe(false);
    expect(looksLikeCopy("https://example.com/a b")).toBe(false);
  });
});
