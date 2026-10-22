import { formatDuration } from "../format.ts";

/**
 * Rich text (summary, chat answer) as plain text for the clipboard: `[[seg:…]]` citations
 * become their `[m:ss]` timestamps; unresolved citations and citations without a known time
 * are dropped rather than leaking marker syntax.
 */
export function plainText(body: string, timeOf: (segmentId: string) => number | undefined): string {
  return body.replace(/\[\[(seg|unresolved):([^\]\s]+)\]\]/g, (_, kind: string, value: string) => {
    if (kind !== "seg") return "";
    const time = timeOf(value);
    return time === undefined ? "" : `[${formatDuration(time)}]`;
  });
}
