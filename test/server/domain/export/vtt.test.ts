import { describe, expect, it } from "vitest";
import { VTT_HEADER, vttCue } from "../../../../src/server/domain/export/vtt.ts";

describe("WebVTT", () => {
  it("starts with the signature and writes cues without ids", () => {
    expect(VTT_HEADER).toBe("WEBVTT\n\n");
    expect(vttCue({ startMs: 61_001, endMs: 62_000, text: "a\nb" })).toBe("00:01:01.001 --> 00:01:02.000\na b\n\n");
  });
});
