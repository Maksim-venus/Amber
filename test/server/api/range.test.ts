import { describe, expect, it } from "vitest";
import { decideRange } from "../../../src/server/api/range.ts";

describe("decideRange", () => {
  it("serves single ranges, open-ended ranges and suffixes, clamped to the file", () => {
    expect(decideRange("bytes=0-99", 1000)).toEqual({ kind: "partial", start: 0, end: 99 });
    expect(decideRange("bytes=900-", 1000)).toEqual({ kind: "partial", start: 900, end: 999 });
    expect(decideRange("bytes=900-5000", 1000)).toEqual({ kind: "partial", start: 900, end: 999 });
    expect(decideRange("bytes=-100", 1000)).toEqual({ kind: "partial", start: 900, end: 999 });
    expect(decideRange("bytes=-5000", 1000)).toEqual({ kind: "partial", start: 0, end: 999 });
  });

  it("is unsatisfiable only for a single range starting at or past the end", () => {
    expect(decideRange("bytes=1000-", 1000)).toEqual({ kind: "unsatisfiable" });
    expect(decideRange("bytes=1000-1100", 1000)).toEqual({ kind: "unsatisfiable" });
    expect(decideRange("bytes=-0", 1000)).toEqual({ kind: "unsatisfiable" });
  });

  it("ignores absent, multiple and malformed ranges and sends the whole file", () => {
    for (const header of [undefined, "bytes=0-1,5-6", "bytes=abc", "items=0-1", "bytes=5-1", "bytes=-", ""]) {
      expect(decideRange(header, 1000), String(header)).toEqual({ kind: "full" });
    }
  });
});
