/** `h:mm:ss` for an hour or more, else `m:ss`; media time is integer milliseconds. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Local date and time for list columns; the UI language picks the format. */
export function formatDateTime(epochMs: number, language: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(epochMs);
}

/** Local time of day only, for a moment on the same date as one shown just before it. */
export function formatTime(epochMs: number, language: string): string {
  return new Intl.DateTimeFormat(language, { timeStyle: "short" }).format(epochMs);
}

/** Whether two moments fall on the same local date. */
export function sameLocalDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}
