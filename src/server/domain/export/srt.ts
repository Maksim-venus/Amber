import { oneLine, type ExportCue } from "./cues.ts";
import { srtTime } from "./time-format.ts";

/**
 * One numbered SRT cue with its trailing blank line. A bilingual cue has two text
 * lines, the original first; `index` counts from 1.
 */
export function srtCue(index: number, cue: ExportCue): string {
  const lines = [oneLine(cue.text)];
  if (cue.translation !== undefined) {
    lines.push(oneLine(cue.translation));
  }
  return `${index}\n${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}\n${lines.join("\n")}\n\n`;
}
