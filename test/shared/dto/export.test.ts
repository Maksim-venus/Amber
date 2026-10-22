import { describe, expect, it } from "vitest";
import { contentExportRequestSchema } from "../../../src/shared/dto/export.ts";
import { defaultSubtitleAppearance, defaultSubtitlePlacement } from "../../../src/shared/subtitle-style.ts";

const style = { appearance: defaultSubtitleAppearance(), placement: defaultSubtitlePlacement() };

describe("subtitle export style", () => {
  it("is accepted for ASS and refused for other formats", () => {
    expect(contentExportRequestSchema.safeParse({ format: "ass", revisionId: "r1", style }).success).toBe(true);
    expect(contentExportRequestSchema.safeParse({ format: "srt", revisionId: "r1", style }).success).toBe(false);
  });
});
