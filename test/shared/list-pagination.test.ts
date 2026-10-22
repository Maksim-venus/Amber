import { describe, expect, it } from "vitest";
import { LIST_PAGE_SIZE_DEFAULT } from "../../src/shared/defaults.ts";
import { isListPageSize, LIST_PAGE_SIZES } from "../../src/shared/list-pagination.ts";

describe("list page sizes", () => {
  it("offers 10 / 15 / 20 / 50 in ascending order", () => {
    expect(LIST_PAGE_SIZES).toEqual([10, 15, 20, 50]);
  });

  it("includes the default", () => {
    expect(isListPageSize(LIST_PAGE_SIZE_DEFAULT)).toBe(true);
  });

  it("rejects anything else", () => {
    for (const value of [0, 13, 100, 10.5, Number.NaN]) expect(isListPageSize(value)).toBe(false);
  });
});
