import { beforeEach, describe, expect, it } from "vitest";
import { forgetNext, isAuthPage, peekNext, rememberNext, safeNextPath, takeNext } from "../../../src/web/auth/next-path.ts";

describe("next path after login", () => {
  beforeEach(() => forgetNext());

  it("accepts only same-origin relative paths outside the auth pages", () => {
    expect(safeNextPath("/contents/x?tab=summary#s")).toBe("/contents/x?tab=summary#s");
    for (const path of ["//evil.example/x", "/\\evil.example", "https://evil.example/", "javascript:alert(1)", "/login", "/login?next=/x", "/setup", ""]) {
      expect(safeNextPath(path), path).toBeUndefined();
    }
  });

  it("remembers in memory, peeks without consuming, takes once, defaults to the library", () => {
    expect(peekNext()).toBe("/library");
    rememberNext("/collections/c1");
    rememberNext("//evil.example");
    expect(peekNext()).toBe("/collections/c1");
    expect(takeNext()).toBe("/collections/c1");
    expect(takeNext()).toBe("/library");
  });

  it("recognizes the pages reachable without a session", () => {
    expect(isAuthPage("/login")).toBe(true);
    expect(isAuthPage("/setup")).toBe(true);
    expect(isAuthPage("/library")).toBe(false);
    expect(isAuthPage("/loginx")).toBe(false);
  });
});
