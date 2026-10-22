import { describe, expect, it } from "vitest";
import { isUlid, segmentIdSchema } from "../../src/shared/ids.ts";

describe("ULID ids", () => {
  it("accepts canonical ULIDs", () => {
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
    expect(segmentIdSchema.parse("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });

  it("rejects lowercase, excluded letters, wrong length and overflowing timestamps", () => {
    for (const value of ["01arz3ndektsv4rrffq69g5fav", "01ARZ3NDEKTSV4RRFFQ69G5FAI", "01ARZ3NDEK", "81ARZ3NDEKTSV4RRFFQ69G5FAV"]) {
      expect(isUlid(value)).toBe(false);
    }
    expect(segmentIdSchema.safeParse("local").success).toBe(false);
  });
});
