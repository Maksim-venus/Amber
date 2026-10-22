import { describe, expect, it } from "vitest";
import {
  MUSIC_LINE_RATIO_MAX,
  SUBTITLE_COVERAGE_MAX,
  SUBTITLE_COVERAGE_MIN,
  SUBTITLE_GAP_MAX_MS,
  SUBTITLE_SUSPICIOUS_MARGIN,
} from "../../../src/shared/defaults.ts";
import { importedSubtitleWarnings, isMusicOrEmptyLine, judgeSubtitle, type TimedLine } from "../../../src/server/domain/subtitle-verdict.ts";

const DURATION = 1_000_000;

/** `count` evenly spaced speech lines whose last one ends at `coverage × DURATION`. */
function lines(coverage: number, count = 100, text = "speech"): TimedLine[] {
  const end = Math.round(coverage * DURATION);
  const step = end / count;
  return Array.from({ length: count }, (_, i) => ({ startMs: Math.round(i * step), endMs: Math.round((i + 1) * step), text }));
}

describe("isMusicOrEmptyLine", () => {
  it("treats empty, note-and-punctuation-only and whole-line annotations as no speech", () => {
    for (const text of ["", "   ", "♪", "♪ ♫ ♬ ♩", "…", "♪～♪", "~", "♪ 音乐 ♪", "♪音樂♪", "MUSIC", "～ Music ～", "[音乐]", "(Music)", "（掌声）", " [applause] "]) {
      expect(isMusicOrEmptyLine(text), text).toBe(true);
    }
  });

  it("keeps lines with speech, including ones that only contain an annotation", () => {
    for (const text of ["♪ 音乐真好听 ♪", "music video", "hello", "[music] and then", "(a) (b)", "$", "1"]) {
      expect(isMusicOrEmptyLine(text), text).toBe(false);
    }
  });
});

describe("judgeSubtitle", () => {
  it("is valid with full coverage, few music lines and no long gap", () => {
    expect(judgeSubtitle(lines(1), DURATION)).toEqual({ verdict: "valid", reasons: [] });
    expect(judgeSubtitle(lines(SUBTITLE_COVERAGE_MIN + SUBTITLE_SUSPICIOUS_MARGIN + 0.001), DURATION).verdict).toBe("valid");
    expect(judgeSubtitle(lines(SUBTITLE_COVERAGE_MAX), DURATION).verdict).toBe("valid");
  });

  it("counts coverage of exactly MIN + MARGIN as valid despite binary floating point", () => {
    const exact = [{ startMs: 0, endMs: 950, text: "speech" }];
    expect(SUBTITLE_COVERAGE_MIN + SUBTITLE_SUSPICIOUS_MARGIN).toBeGreaterThan(0.95);
    expect(judgeSubtitle(exact, 1000)).toEqual({ verdict: "valid", reasons: [] });
    expect(judgeSubtitle([{ startMs: 0, endMs: 949, text: "speech" }], 1000).verdict).toBe("suspicious");
  });

  it("is invalid below or above the coverage bounds and with too many music lines, listing every reason", () => {
    expect(judgeSubtitle(lines(0.2), DURATION)).toEqual({ verdict: "invalid", reasons: ["subtitle_coverage_low"] });
    expect(judgeSubtitle(lines(SUBTITLE_COVERAGE_MAX + 0.01), DURATION)).toEqual({ verdict: "invalid", reasons: ["subtitle_coverage_high"] });
    const music = lines(1).map((line, i) => (i < 60 ? { ...line, text: "♪" } : line));
    expect(MUSIC_LINE_RATIO_MAX).toBeLessThan(0.6);
    expect(judgeSubtitle(music, DURATION)).toEqual({ verdict: "invalid", reasons: ["subtitle_music_lines"] });
    const lowAndMusic = lines(0.01, 19, "♪ ♪");
    expect(judgeSubtitle(lowAndMusic, DURATION)).toEqual({ verdict: "invalid", reasons: ["subtitle_coverage_low", "subtitle_music_lines"] });
  });

  it("treats no lines at all as invalid", () => {
    expect(judgeSubtitle([], DURATION)).toEqual({ verdict: "invalid", reasons: ["subtitle_coverage_low", "subtitle_music_lines"] });
  });

  it("is suspicious with marginal coverage or a long internal gap", () => {
    expect(judgeSubtitle(lines(SUBTITLE_COVERAGE_MIN + SUBTITLE_SUSPICIOUS_MARGIN / 2), DURATION)).toEqual({
      verdict: "suspicious",
      reasons: ["subtitle_coverage_marginal"],
    });
    const gapped = lines(1).filter((line) => line.startMs < 300_000 || line.startMs >= 300_000 + SUBTITLE_GAP_MAX_MS + 10_000);
    expect(judgeSubtitle(gapped, DURATION)).toEqual({ verdict: "suspicious", reasons: ["subtitle_gap"] });
  });

  it("measures gaps between reached ends in start order, so overlapping cues do not open a gap", () => {
    const overlapping: TimedLine[] = [
      { startMs: 0, endMs: 900_000, text: "long" },
      { startMs: 10_000, endMs: 20_000, text: "inside" },
      { startMs: 900_000, endMs: DURATION, text: "tail" },
    ];
    expect(judgeSubtitle(overlapping, DURATION)).toEqual({ verdict: "valid", reasons: [] });
  });

  it("refuses a non-positive duration", () => {
    expect(() => judgeSubtitle(lines(1), 0)).toThrow(RangeError);
  });
});

describe("importedSubtitleWarnings", () => {
  it("reports nothing for a valid subtitle or an unknown duration", () => {
    expect(importedSubtitleWarnings(lines(1), DURATION)).toEqual([]);
    expect(importedSubtitleWarnings(lines(0.1), 0)).toEqual([]);
  });

  it("reports the verdict and its reasons as warning codes", () => {
    expect(importedSubtitleWarnings(lines(0.1), DURATION)).toEqual(["imported_subtitle_invalid", "subtitle_coverage_low"]);
    expect(importedSubtitleWarnings(lines(SUBTITLE_COVERAGE_MIN + 0.01), DURATION)).toEqual(["imported_subtitle_suspicious", "subtitle_coverage_marginal"]);
  });
});
