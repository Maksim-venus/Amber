import {
  MUSIC_LINE_RATIO_MAX,
  SUBTITLE_COVERAGE_MAX,
  SUBTITLE_COVERAGE_MIN,
  SUBTITLE_GAP_MAX_MS,
  SUBTITLE_SUSPICIOUS_MARGIN,
} from "../../shared/defaults.ts";

/** Subtitle completeness verdicts; `none` means the platform offered no subtitle track at all. */
export const SUBTITLE_VERDICTS = ["valid", "suspicious", "invalid", "none"] as const;
export type SubtitleVerdict = (typeof SUBTITLE_VERDICTS)[number];

/** Why a subtitle was judged the way it was; recorded in `StageRun.resultJson.reasons`. */
export type SubtitleVerdictReason =
  | "subtitle_coverage_low"
  | "subtitle_coverage_high"
  | "subtitle_music_lines"
  | "subtitle_coverage_marginal"
  | "subtitle_gap";

export interface TimedLine {
  startMs: number;
  endMs: number;
  text: string;
}

export interface SubtitleJudgement {
  verdict: Exclude<SubtitleVerdict, "none">;
  reasons: SubtitleVerdictReason[];
}

const MUSIC_SYMBOLS_AND_PUNCTUATION = /[\s♪♫♩♬～~\p{P}]/gu;
const MUSIC_WORDS: ReadonlySet<string> = new Set(["音乐", "音樂", "music"]);
const ANNOTATION = /^(?:\[[^\]]*\]|\([^)]*\)|（[^）]*）)$/u;

/**
 * A line that carries no speech: empty after trimming; only music notes,
 * punctuation and `～`; nothing but the word 音乐 / Music once those are removed (as in
 * bilibili's "♪ 音乐 ♪"); or a whole-line `[…]` / `(…)` / `（…）` annotation.
 */
export function isMusicOrEmptyLine(text: string): boolean {
  const trimmed = text.trim();
  const bare = trimmed.replace(MUSIC_SYMBOLS_AND_PUNCTUATION, "").toLowerCase();
  return bare === "" || MUSIC_WORDS.has(bare) || ANNOTATION.test(trimmed);
}

/**
 * Lower bound of `valid` coverage. The sum is rounded because binary floating point makes
 * 0.9 + 0.05 slightly above 0.95, which would turn an exact 95 % into `suspicious`.
 */
const VALID_COVERAGE_FROM = Math.round((SUBTITLE_COVERAGE_MIN + SUBTITLE_SUSPICIOUS_MARGIN) * 1e9) / 1e9;

/**
 * Completeness judgement, evaluated in rule order: any `invalid` rule
 * first, then `suspicious`, otherwise `valid`. `lines` are the usable cues (cues with
 * broken timing were already dropped); `durationMs` is the media length.
 */
export function judgeSubtitle(lines: readonly TimedLine[], durationMs: number): SubtitleJudgement {
  if (!(durationMs > 0)) {
    throw new RangeError("subtitle judgement needs a positive media duration");
  }
  const lastEndMs = lines.reduce((end, line) => Math.max(end, line.endMs), 0);
  const coverage = lastEndMs / durationMs;
  const musicRatio = lines.length === 0 ? 1 : lines.filter((line) => isMusicOrEmptyLine(line.text)).length / lines.length;

  const invalid: SubtitleVerdictReason[] = [];
  if (coverage < SUBTITLE_COVERAGE_MIN) {
    invalid.push("subtitle_coverage_low");
  }
  if (coverage > SUBTITLE_COVERAGE_MAX) {
    invalid.push("subtitle_coverage_high");
  }
  if (musicRatio > MUSIC_LINE_RATIO_MAX) {
    invalid.push("subtitle_music_lines");
  }
  if (invalid.length > 0) {
    return { verdict: "invalid", reasons: invalid };
  }

  const suspicious: SubtitleVerdictReason[] = [];
  if (coverage < VALID_COVERAGE_FROM) {
    suspicious.push("subtitle_coverage_marginal");
  }
  if (largestInternalGapMs(lines) > SUBTITLE_GAP_MAX_MS) {
    suspicious.push("subtitle_gap");
  }
  return suspicious.length > 0 ? { verdict: "suspicious", reasons: suspicious } : { verdict: "valid", reasons: [] };
}

/** Longest silence between one cue's end and the next cue's start, in start order. */
function largestInternalGapMs(lines: readonly TimedLine[]): number {
  const ordered = [...lines].sort((a, b) => a.startMs - b.startMs);
  let reachedMs = ordered[0]?.endMs ?? 0;
  let largest = 0;
  for (const line of ordered.slice(1)) {
    largest = Math.max(largest, line.startMs - reachedMs);
    reachedMs = Math.max(reachedMs, line.endMs);
  }
  return largest;
}

/**
 * Timeline sanity check of a user-imported subtitle once the media duration is known:
 * the same judgement as for platform subtitles, reported only as warning codes because
 * the user's own subtitle is never replaced automatically.
 */
export function importedSubtitleWarnings(lines: readonly TimedLine[], durationMs: number): string[] {
  if (!(durationMs > 0)) {
    return [];
  }
  const { verdict, reasons } = judgeSubtitle(lines, durationMs);
  return verdict === "valid" ? [] : [`imported_subtitle_${verdict}`, ...reasons];
}
