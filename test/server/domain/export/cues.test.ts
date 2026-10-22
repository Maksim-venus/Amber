import { describe, expect, it } from "vitest";
import { oneLine } from "../../../../src/server/domain/export/cues.ts";

describe("oneLine", () => {
  it("turns every line break into a space", () => {
    expect(oneLine("a\r\nb\rc\nd")).toBe("a b c d");
  });
});
