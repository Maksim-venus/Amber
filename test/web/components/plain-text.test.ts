import { describe, expect, it } from "vitest";
import { plainText } from "../../../src/web/components/plain-text.ts";

describe("plainText", () => {
  it("turns citations into timestamps and drops unresolved markers", () => {
    expect(plainText("甲 [[seg:s1]] 乙 [[unresolved:s9]]", (id) => (id === "s1" ? 75_000 : undefined))).toBe("甲 [1:15] 乙 ");
  });

  it("drops a citation whose time is not known", () => {
    expect(plainText("甲[[seg:s2]]", () => undefined)).toBe("甲");
  });
});
