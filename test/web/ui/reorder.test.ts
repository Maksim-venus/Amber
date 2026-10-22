import { describe, expect, it } from "vitest";
import { dropIndex, moveItem } from "../../../src/web/ui/reorder.ts";

describe("reorder helpers", () => {
  it("moves an element and clamps the target", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, -5)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b", "c"], 7, 0)).toEqual(["a", "b", "c"]);
  });

  it("finds the row whose midpoint is below the pointer", () => {
    const rows = [
      { top: 0, height: 40 },
      { top: 40, height: 40 },
      { top: 80, height: 40 },
    ];
    expect(dropIndex(10, rows)).toBe(0);
    expect(dropIndex(70, rows)).toBe(2);
    expect(dropIndex(500, rows)).toBe(2);
  });
});
