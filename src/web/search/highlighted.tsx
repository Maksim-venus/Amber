import type { SearchRange } from "../../shared/dto/search.ts";
import { normalizeRanges } from "./search.ts";

/**
 * Text with the given spans marked. Spans are offsets into the plain text,
 * rendered as React text nodes inside `<mark>`, never as HTML.
 */
export function Highlighted(props: { text: string; ranges: readonly SearchRange[]; className?: string }) {
  const parts: Array<{ text: string; marked: boolean }> = [];
  let at = 0;
  for (const range of normalizeRanges(props.text, props.ranges)) {
    if (range.start > at) parts.push({ text: props.text.slice(at, range.start), marked: false });
    parts.push({ text: props.text.slice(range.start, range.end), marked: true });
    at = range.end;
  }
  if (at < props.text.length) parts.push({ text: props.text.slice(at), marked: false });
  return (
    <span className={props.className}>
      {parts.map((part, index) =>
        part.marked ? (
          <mark key={index} className="rounded-sm bg-amber-300/50 px-0.5 text-inherit">
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </span>
  );
}
