/**
 * YouTube's automatic captions in WebVTT repeat the previous cue's line at the top of
 * each cue and insert short "hold" cues while the text scrolls. Dropping every cue line
 * that repeats a line of the previous cue leaves each spoken line once, in the cue where
 * it first appeared. Word-timing tags are left for the subtitle parser to strip.
 */
export function collapseRollingCaptions(vtt: string): string {
  const blocks = vtt.split(/\r?\n\r?\n/);
  let previous = new Set<string>();
  const out: string[] = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const timing = lines.findIndex((line) => line.includes("-->"));
    if (timing < 0) {
      out.push(block);
      continue;
    }
    const text = lines.slice(timing + 1);
    const plain = text.map((line) => line.replace(/<[^>]*>/g, "").trim());
    const kept = text.filter((_, index) => plain[index] !== "" && !previous.has(plain[index] as string));
    previous = new Set(plain.filter((line) => line !== ""));
    if (kept.length > 0) {
      out.push([...lines.slice(0, timing + 1), ...kept].join("\n"));
    }
  }
  return out.join("\n\n");
}
