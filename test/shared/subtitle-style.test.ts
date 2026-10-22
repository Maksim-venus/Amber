import { describe, expect, it } from "vitest";
import { SUBTITLE_FONT_SIZE_MAX, SUBTITLE_PLACEMENT_Y_BP } from "../../src/shared/defaults.ts";
import {
  boxedLines,
  lineBoxPadding,
  defaultSubtitleAppearance,
  defaultSubtitlePlacement,
  subtitleAppearanceSchema,
  subtitlePlacementSchema,
  subtitleStyleSchema,
  type SubtitleAppearance,
} from "../../src/shared/subtitle-style.ts";

describe("subtitle style schemas", () => {
  it("accepts the system defaults", () => {
    expect(subtitleAppearanceSchema.parse(defaultSubtitleAppearance())).toEqual(defaultSubtitleAppearance());
    expect(subtitlePlacementSchema.parse(defaultSubtitlePlacement())).toEqual({ version: 1, xBp: 5000, yBp: SUBTITLE_PLACEMENT_Y_BP, anchor: "bottom" });
  });

  it("stores colours upper-case so equal styles serialize alike", () => {
    const appearance = { ...defaultSubtitleAppearance(), original: { fontSize: 48, color: "#a1b2c3" } };
    expect(subtitleAppearanceSchema.parse(appearance).original.color).toBe("#A1B2C3");
  });

  it.each([
    ["a colour name", { original: { fontSize: 48, color: "white" } }],
    ["a short hex colour", { original: { fontSize: 48, color: "#fff" } }],
    ["a font size above the cap", { original: { fontSize: SUBTITLE_FONT_SIZE_MAX + 1, color: "#FFFFFF" } }],
    ["a fractional font size", { original: { fontSize: 47.5, color: "#FFFFFF" } }],
    ["an unknown field", { shadow: true }],
    ["another version", { version: 2 }],
  ])("rejects %s", (_, patch) => {
    expect(subtitleAppearanceSchema.safeParse({ ...defaultSubtitleAppearance(), ...patch }).success).toBe(false);
  });

  it.each([
    ["x beyond the picture", { xBp: 10001 }],
    ["a negative y", { yBp: -1 }],
    ["a fractional coordinate", { xBp: 12.5 }],
    ["an unknown anchor", { anchor: "left" }],
  ])("rejects a placement with %s", (_, patch) => {
    expect(subtitlePlacementSchema.safeParse({ ...defaultSubtitlePlacement(), ...patch }).success).toBe(false);
  });

  it("requires both halves of a style", () => {
    expect(subtitleStyleSchema.safeParse({ appearance: defaultSubtitleAppearance() }).success).toBe(false);
    expect(subtitleStyleSchema.safeParse({ appearance: defaultSubtitleAppearance(), placement: defaultSubtitlePlacement() }).success).toBe(true);
  });
});

describe("background box scope", () => {
  it("reads preferences and requests saved before the scope existed as `both`, keeping everything else", () => {
    const saved = defaultSubtitleAppearance();
    const { scope: _scope, ...withoutScope } = saved.background;
    const legacy = { ...saved, original: { fontSize: 60, color: "#123456" }, background: { ...withoutScope, enabled: true, opacityPct: 80 } };
    const parsed = subtitleAppearanceSchema.parse(legacy);
    expect(parsed.background).toEqual({ ...withoutScope, enabled: true, opacityPct: 80, scope: "both" });
    expect(parsed.original).toEqual({ fontSize: 60, color: "#123456" });
    expect(subtitleStyleSchema.parse({ appearance: legacy, placement: defaultSubtitlePlacement() }).appearance.background.scope).toBe("both");
  });

  it("keeps a chosen scope and rejects an unknown one", () => {
    const appearance = defaultSubtitleAppearance();
    expect(subtitleAppearanceSchema.parse({ ...appearance, background: { ...appearance.background, scope: "translation" } }).background.scope).toBe("translation");
    expect(subtitleAppearanceSchema.safeParse({ ...appearance, background: { ...appearance.background, scope: "neither" } }).success).toBe(false);
  });

  const withBox = (enabled: boolean, scope: SubtitleAppearance["background"]["scope"]): SubtitleAppearance => {
    const appearance = defaultSubtitleAppearance();
    return { ...appearance, background: { ...appearance.background, enabled, scope } };
  };

  it("draws no box while the box is off, whatever the scope", () => {
    expect(boxedLines(withBox(false, "translation"), "bilingual")).toBe("none");
    expect(boxedLines(withBox(false, "both"), "original")).toBe("none");
  });

  it("boxes the whole block for single-language modes and the `both` scope", () => {
    expect(boxedLines(withBox(true, "both"), "bilingual")).toBe("block");
    expect(boxedLines(withBox(true, "translation"), "original")).toBe("block");
    expect(boxedLines(withBox(true, "original"), "translation")).toBe("block");
  });

  it("boxes one bilingual line when the scope names it", () => {
    expect(boxedLines(withBox(true, "original"), "bilingual")).toBe("original");
    expect(boxedLines(withBox(true, "translation"), "bilingual")).toBe("translation");
  });

  it("pads a one-line box by at least 1, since BorderStyle 3 draws nothing at Outline 0", () => {
    const appearance = defaultSubtitleAppearance();
    expect(lineBoxPadding({ ...appearance, background: { ...appearance.background, padding: 0 } })).toBe(1);
    expect(lineBoxPadding({ ...appearance, background: { ...appearance.background, padding: 12 } })).toBe(12);
  });
});
