/**
 * Time stamps of exported files. Media time is integer milliseconds; hours
 * are never truncated, so a six-hour lecture keeps its hour digits in every format.
 */

const pad = (value: number, width: number): string => String(value).padStart(width, "0");

function parts(ms: number): { h: number; m: number; s: number; ms: number } {
  const total = Math.max(0, Math.floor(ms));
  return {
    h: Math.floor(total / 3_600_000),
    m: Math.floor((total % 3_600_000) / 60_000),
    s: Math.floor((total % 60_000) / 1000),
    ms: total % 1000,
  };
}

/** SRT `HH:MM:SS,mmm`. */
export function srtTime(ms: number): string {
  const t = parts(ms);
  return `${pad(t.h, 2)}:${pad(t.m, 2)}:${pad(t.s, 2)},${pad(t.ms, 3)}`;
}

/** WebVTT `HH:MM:SS.mmm`. */
export function vttTime(ms: number): string {
  const t = parts(ms);
  return `${pad(t.h, 2)}:${pad(t.m, 2)}:${pad(t.s, 2)}.${pad(t.ms, 3)}`;
}

/** ASS `H:MM:SS.cc` in centiseconds, truncated rather than rounded. */
export function assTime(ms: number): string {
  const t = parts(ms);
  return `${t.h}:${pad(t.m, 2)}:${pad(t.s, 2)}.${pad(Math.floor(t.ms / 10), 2)}`;
}

/** A Markdown time stamp without brackets: `mm:ss`, or `h:mm:ss` from the 100th minute on. */
export function markdownTime(ms: number): string {
  const t = parts(ms);
  const minutes = t.h * 60 + t.m;
  return minutes < 100 ? `${pad(minutes, 2)}:${pad(t.s, 2)}` : `${t.h}:${pad(t.m, 2)}:${pad(t.s, 2)}`;
}

/** The Markdown export's `{{duration}}` placeholder: `h:mm:ss`. */
export function durationText(ms: number): string {
  const t = parts(ms);
  return `${t.h}:${pad(t.m, 2)}:${pad(t.s, 2)}`;
}

/** The Markdown export's `{{date}}` placeholder: `YYYY-MM-DD` in the time zone of the running process. */
export function dateText(epochMs: number): string {
  const date = new Date(epochMs);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

/** `YYYY-MM-DD HH:mm` in the time zone of the running process, for revision labels. */
export function dateTimeText(epochMs: number): string {
  const date = new Date(epochMs);
  return `${dateText(epochMs)} ${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}`;
}
