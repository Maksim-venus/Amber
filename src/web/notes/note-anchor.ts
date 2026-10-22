import { NOTE_SPAN_MAX_SEGMENTS } from "../../shared/defaults.ts";
import type { NoteDto } from "../../shared/dto/note.ts";
import type { TranscriptSegmentDto } from "../../shared/dto/transcript.ts";
import { isMarked, readingSeparator } from "../../shared/reading.ts";
import type { SelectionBounds } from "../ui/dom-selection.ts";

/** Where a new note sits: the revision read, its first and last sentence and UTF-16 offsets in them. */
export interface NoteAnchor {
  transcriptRevisionId: string;
  startSegmentId: string;
  startOffset: number;
  endSegmentId: string;
  endOffset: number;
}

export type AnchorResult =
  | { ok: true; anchor: NoteAnchor; excerpt: string }
  /** `tooLong`: more sentences than NOTE_SPAN_MAX_SEGMENTS; `unavailable`: the sentences are not in the loaded data. */
  | { ok: false; reason: "tooLong" | "unavailable" };

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** Moves an offset off the middle of a surrogate pair: a start back to the pair, an end past it. */
function wholeCharacter(text: string, offset: number, edge: "start" | "end"): number {
  if (offset <= 0 || offset >= text.length) return offset;
  if (!isHighSurrogate(text.charCodeAt(offset - 1)) || !isLowSurrogate(text.charCodeAt(offset))) return offset;
  return edge === "start" ? offset - 1 : offset + 1;
}

/**
 * Turns frozen selection bounds into a note anchor using the revision's sentence data: the
 * span is counted by ordinals, ends are put in ordinal order, offsets are clamped to the
 * text and never split a surrogate pair. The excerpt is what the server will quote.
 */
export function anchorFromBounds(bounds: SelectionBounds, segments: readonly TranscriptSegmentDto[] | undefined): AnchorResult {
  if (segments === undefined) return { ok: false, reason: "unavailable" };
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  let from = bounds.start;
  let to = bounds.end;
  let first = byId.get(from.segmentId);
  let last = byId.get(to.segmentId);
  if (first === undefined || last === undefined) return { ok: false, reason: "unavailable" };
  if (first.ordinal > last.ordinal) {
    [first, last] = [last, first];
    [from, to] = [to, from];
  }
  if (last.ordinal - first.ordinal + 1 > NOTE_SPAN_MAX_SEGMENTS) return { ok: false, reason: "tooLong" };
  const startOffset = wholeCharacter(first.text, Math.min(Math.max(0, from.offset), first.text.length), "start");
  const endOffset = wholeCharacter(last.text, Math.min(Math.max(0, to.offset), last.text.length), "end");
  if (startOffset >= first.text.length || endOffset <= 0 || (first.id === last.id && startOffset >= endOffset)) {
    return { ok: false, reason: "unavailable" };
  }
  const anchor: NoteAnchor = { transcriptRevisionId: bounds.revisionId, startSegmentId: first.id, startOffset, endSegmentId: last.id, endOffset };
  return { ok: true, anchor, excerpt: anchorExcerpt(anchor, segments) };
}

/**
 * The anchored text as the server quotes it: one sentence is sliced; across
 * sentences it is the first one's tail, the middle ones whole and the last one's head,
 * joined by the reading separator.
 */
export function anchorExcerpt(anchor: NoteAnchor, segments: readonly TranscriptSegmentDto[]): string {
  const ordered = [...segments].sort((a, b) => a.ordinal - b.ordinal);
  const from = ordered.findIndex((segment) => segment.id === anchor.startSegmentId);
  const to = ordered.findIndex((segment) => segment.id === anchor.endSegmentId);
  if (from < 0 || to < from) return "";
  if (from === to) return (ordered[from] as TranscriptSegmentDto).text.slice(anchor.startOffset, anchor.endOffset);
  const span = ordered.slice(from, to + 1);
  let quote = "";
  span.forEach((segment, index) => {
    const part = index === 0 ? segment.text.slice(anchor.startOffset) : index === span.length - 1 ? segment.text.slice(0, anchor.endOffset) : segment.text;
    const previous = span[index - 1];
    quote += previous === undefined ? part : `${readingSeparator(previous.text, segment.text, isMarked(previous))}${part}`;
  });
  return quote;
}

/** A note's share of one sentence in the revision being read. */
export interface SentenceNote {
  note: NoteDto;
  start: number;
  end: number;
  /** This is the note's last sentence here, where its comment badge goes. */
  last: boolean;
}

/**
 * Notes placed on the sentences of the revision being read, from each note's `view`: exact
 * views keep their offsets, approximate ones cover whole sentences, and notes that cannot be
 * placed (`view: null`) are left out.
 */
export function notesBySegment(notes: readonly NoteDto[], segments: readonly TranscriptSegmentDto[]): Map<string, SentenceNote[]> {
  const lengths = new Map(segments.map((segment) => [segment.id, segment.text.length]));
  const placed = new Map<string, SentenceNote[]>();
  for (const note of notes) {
    const view = note.view;
    if (view == null) continue;
    view.segments.forEach((part, index) => {
      const length = lengths.get(part.segmentId);
      if (length === undefined) return;
      const start = view.exact ? Math.min(part.startOffset, length) : 0;
      const end = view.exact ? Math.min(part.endOffset, length) : length;
      if (end <= start) return;
      const list = placed.get(part.segmentId) ?? [];
      list.push({ note, start, end, last: index === view.segments.length - 1 });
      placed.set(part.segmentId, list);
    });
  }
  return placed;
}

/** Newest first: by creation time, a tie going to the larger id. */
export function newestFirst(a: NoteDto, b: NoteDto): number {
  return b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}
