import { describe, expect, it } from "vitest";
import { SetupToken } from "../../../../../src/server/adapters/auth/server/setup-token.ts";
import { SETUP_TOKEN_TTL_MIN } from "../../../../../src/shared/defaults.ts";

describe("SetupToken", () => {
  it("is 32 random bytes in base64url, valid until SETUP_TOKEN_TTL_MIN and until consumed", () => {
    const clock = { now: 1000 };
    const token = new SetupToken({ now: () => clock.now });
    expect(Buffer.from(token.value, "base64url")).toHaveLength(32);
    expect(token.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new SetupToken().value).not.toBe(token.value);
    expect(token.matches(undefined)).toBe(false);
    expect(token.matches(token.value.slice(1))).toBe(false);
    // A failed attempt consumes nothing.
    expect(token.matches(token.value)).toBe(true);
    clock.now += SETUP_TOKEN_TTL_MIN * 60_000 - 1;
    expect(token.matches(token.value)).toBe(true);
    clock.now += 1;
    expect(token.matches(token.value)).toBe(false);
  });

  it("is spent once consumed", () => {
    const token = new SetupToken();
    token.consume();
    expect(token.matches(token.value)).toBe(false);
  });
});
