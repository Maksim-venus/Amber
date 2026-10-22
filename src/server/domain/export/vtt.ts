import { oneLine, type ExportCue } from "./cues.ts";
import { vttTime } from "./time-format.ts";

/** The WebVTT file header: the signature line and a blank line. */
export const VTT_HEADER = "WEBVTT\n\n";

/** One WebVTT cue without id or settings, followed by a blank line. */
export function vttCue(cue: ExportCue): string {
  return `${vttTime(cue.startMs)} --> ${vttTime(cue.endMs)}\n${oneLine(cue.text)}\n\n`;
}
