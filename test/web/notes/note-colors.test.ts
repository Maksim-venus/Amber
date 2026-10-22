import { beforeEach, describe, expect, it } from "vitest";
import { rememberColor, rememberedColor } from "../../../src/web/notes/note-colors.ts";

beforeEach(() => {
  localStorage.clear();
});

describe("note colour memory", () => {
  it("starts underline blue and background yellow", () => {
    expect(rememberedColor("underline")).toBe("blue");
    expect(rememberedColor("background")).toBe("yellow");
  });

  it("remembers the last colour per mark and ignores values it does not know", () => {
    rememberColor("background", "pink");
    expect(rememberedColor("background")).toBe("pink");
    expect(rememberedColor("underline")).toBe("blue");
    localStorage.setItem("amber.notes.color.underline", "orange");
    expect(rememberedColor("underline")).toBe("blue");
  });
});
