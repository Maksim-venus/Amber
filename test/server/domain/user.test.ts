import { describe, expect, it } from "vitest";
import { isAcceptablePassword, normalizeUsername } from "../../../src/server/domain/user.ts";
import { PASSWORD_MIN_LEN } from "../../../src/shared/defaults.ts";

describe("normalizeUsername", () => {
  it("trims, applies NFKC and lowercases ASCII", () => {
    expect(normalizeUsername("  Alice.B_1-x ")).toBe("alice.b_1-x");
    // Fullwidth letters fold to ASCII under NFKC.
    expect(normalizeUsername("ＡＢＣ")).toBe("abc");
  });

  it("rejects names outside 3–32 characters of [a-z0-9._-]", () => {
    for (const raw of ["ab", "a".repeat(33), "has space", "ümlaut", "", "name@host"]) {
      expect(normalizeUsername(raw), raw).toBeUndefined();
    }
    expect(normalizeUsername("a".repeat(32))).toBe("a".repeat(32));
  });
});

describe("isAcceptablePassword", () => {
  it("requires PASSWORD_MIN_LEN code points and nothing else", () => {
    expect(isAcceptablePassword("x".repeat(PASSWORD_MIN_LEN - 1))).toBe(false);
    expect(isAcceptablePassword("x".repeat(PASSWORD_MIN_LEN))).toBe(true);
    expect(isAcceptablePassword("密".repeat(PASSWORD_MIN_LEN))).toBe(true);
  });
});
