import type { CanonicalSubtitle } from "../../../src/server/ports/platform-source.ts";

/**
 * Synthetic platform subtitles, generated rather than stored. The four verdict fixtures
 * run on a ten-minute video; the lecture fixtures reproduce the structure measured on the
 * first use-case course (duration, line count, where the lines stop, music lines) with
 * placeholder text only.
 */

export type Cue = CanonicalSubtitle["cues"][number];

const MINUTE_MS = 60_000;

/** `count` back-to-back cues spread evenly over `[0, endMs)`. */
export function evenCues(count: number, endMs: number, text: (index: number) => string = (index) => `line ${index + 1}`): Cue[] {
  return Array.from({ length: count }, (_, index) => ({
    startMs: Math.round((index * endMs) / count),
    endMs: Math.round(((index + 1) * endMs) / count),
    text: text(index),
  }));
}

export const VERDICT_DURATION_MS = 10 * MINUTE_MS;

export interface VerdictFixture {
  /** `undefined`: the platform offers no subtitle track at all. */
  cues: Cue[] | undefined;
  verdict: "valid" | "suspicious" | "invalid" | "none";
  reasons: string[];
}

/** One fixture per subtitle-stage verdict on a `VERDICT_DURATION_MS` video. */
export const VERDICT_FIXTURES: Record<VerdictFixture["verdict"], VerdictFixture> = {
  valid: { cues: evenCues(120, VERDICT_DURATION_MS), verdict: "valid", reasons: [] },
  // Stops at 92 %: above the coverage minimum but inside the suspicious margin.
  suspicious: {
    cues: evenCues(110, 0.92 * VERDICT_DURATION_MS),
    verdict: "suspicious",
    reasons: ["subtitle_incomplete", "subtitle_coverage_marginal"],
  },
  // Stops at 20 %.
  invalid: { cues: evenCues(24, 0.2 * VERDICT_DURATION_MS), verdict: "invalid", reasons: ["subtitle_incomplete", "subtitle_coverage_low"] },
  none: { cues: undefined, verdict: "none", reasons: ["subtitle_none"] },
};

export interface LectureFixture {
  name: string;
  durationMs: number;
  cues: Cue[];
  chapterCount: number;
  valid: boolean;
}

function lecture(name: string, minutes: number, lines: number, stopsAtMs: number, chapterCount: number, text?: (index: number) => string): LectureFixture {
  const durationMs = minutes * MINUTE_MS;
  return { name, durationMs, cues: evenCues(lines, stopsAtMs, text), chapterCount, valid: stopsAtMs === durationMs && text === undefined };
}

/** Structure-equivalent stand-ins for lectures 1–6 and the short film of the first use-case course. */
export function lectureFixtures(): LectureFixture[] {
  return [
    lecture("01", 100, 126, (20 * 60 + 25) * 1000, 5),
    lecture("02", 98, 19, Math.round(0.01 * 98 * MINUTE_MS), 3, () => "♪ 音乐 ♪"),
    lecture("03", 100, 2513, 100 * MINUTE_MS, 3),
    lecture("04", 98, 2427, 98 * MINUTE_MS, 3),
    lecture("05", 100, 2583, 100 * MINUTE_MS, 4),
    lecture("06", 97, 2387, 97 * MINUTE_MS, 4),
    // The short film's subtitle runs to 27:40, far past the video itself.
    lecture("short", 3, 869, (27 * 60 + 40) * 1000, 0),
  ];
}

/** `count` creator chapters spread evenly, with start times only, as platforms report them. */
export function evenChapters(count: number, durationMs: number): Array<{ startMs: number; title: string }> {
  return Array.from({ length: count }, (_, index) => ({ startMs: Math.round((index * durationMs) / count), title: `Chapter ${index + 1}` }));
}
