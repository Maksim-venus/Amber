import { Fragment, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SearchRange } from "../../shared/dto/search.ts";
import { normalizeRanges } from "../search/search.ts";
import { newestFirst, type SentenceNote } from "./note-anchor.ts";
import { backgroundClass, underlineClass } from "./note-colors.ts";

interface Piece {
  start: number;
  end: number;
  notes: SentenceNote[];
  marked: boolean;
}

/**
 * Cuts a sentence at every note and search-range edge, merging neighbours covered by the same
 * notes and search state, so each piece renders as one run.
 */
export function textPieces(length: number, notes: readonly SentenceNote[], ranges: readonly SearchRange[]): Piece[] {
  const cuts = new Set<number>([0, length]);
  for (const note of notes) {
    cuts.add(Math.min(Math.max(0, note.start), length));
    cuts.add(Math.min(Math.max(0, note.end), length));
  }
  for (const range of ranges) {
    cuts.add(range.start);
    cuts.add(range.end);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const pieces: Piece[] = [];
  for (let index = 0; index + 1 < points.length; index += 1) {
    const start = points[index] as number;
    const end = points[index + 1] as number;
    if (end <= start) continue;
    const covering = notes.filter((note) => note.start <= start && note.end >= end);
    const marked = ranges.some((range) => range.start <= start && range.end >= end);
    const previous = pieces.at(-1);
    if (previous !== undefined && previous.marked === marked && sameNotes(previous.notes, covering)) {
      previous.end = end;
    } else {
      pieces.push({ start, end, notes: covering, marked });
    }
  }
  return pieces;
}

function sameNotes(a: readonly SentenceNote[], b: readonly SentenceNote[]): boolean {
  return a.length === b.length && a.every((item, index) => item.note.id === b[index]?.note.id);
}

/**
 * The look of a run: its background is the newest background note covering
 * it, its underline the newest underline note's colour.
 */
export function runClasses(notes: readonly SentenceNote[]): string {
  const sorted = notes.map((item) => item.note).sort(newestFirst);
  const background = sorted.find((note) => note.mark === "background");
  const underline = sorted.find((note) => note.mark === "underline");
  return [
    "cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-accent",
    background === undefined ? "" : backgroundClass(background.color),
    underline === undefined ? "" : underlineClass(underline.color),
  ]
    .filter((part) => part !== "")
    .join(" ");
}

/** A search hit inside the text; drawn above note and change backgrounds. */
function SearchMark(props: { children: ReactNode }) {
  return <mark className="rounded-sm bg-amber-300/50 px-0.5 text-inherit">{props.children}</mark>;
}

/**
 * A sentence's text with its notes and search hits. No wrapping element: undecorated text is
 * exactly one text node, so the sentence keeps its DOM shape and text offsets. A run with
 * notes is focusable and opens them with a click, Enter or Space; that click never reaches
 * the sentence (it would seek), and a click that ends a text selection opens nothing.
 */
export function DecoratedText(props: {
  text: string;
  notes?: readonly SentenceNote[];
  search?: readonly SearchRange[];
  onOpenNotes?: (noteIds: string[], run: HTMLElement) => void;
}) {
  const { t } = useTranslation();
  const notes = props.notes ?? [];
  const ranges = props.search === undefined ? [] : normalizeRanges(props.text, props.search);
  if (notes.length === 0 && ranges.length === 0) return <>{props.text}</>;
  const pieces = textPieces(props.text.length, notes, ranges);
  return (
    <>
      {pieces.map((piece) => {
        const text = props.text.slice(piece.start, piece.end);
        const body = piece.marked ? <SearchMark>{text}</SearchMark> : text;
        if (piece.notes.length === 0) return <Fragment key={piece.start}>{body}</Fragment>;
        const ordered = [...piece.notes].sort((a, b) => newestFirst(a.note, b.note));
        const ids = ordered.map((item) => item.note.id);
        const commented = piece.notes.some((item) => item.note.comment !== undefined);
        // The badge sits where a commented note ends in its last sentence.
        const badge = piece.notes.some((item) => item.last && item.end === piece.end && item.note.comment !== undefined);
        const open = (run: HTMLElement): void => props.onOpenNotes?.(ids, run);
        return (
          <span
            key={piece.start}
            role="button"
            tabIndex={0}
            data-testid="note-run"
            data-note-ids={ids.join(" ")}
            aria-label={t(commented ? "notes.run.labelWithComment" : "notes.run.label", { count: ids.length })}
            className={badge ? `relative ${runClasses(piece.notes)}` : runClasses(piece.notes)}
            onClick={(event: MouseEvent<HTMLSpanElement>) => {
              event.stopPropagation();
              if (window.getSelection()?.isCollapsed === false) return;
              open(event.currentTarget);
            }}
            onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              open(event.currentTarget);
            }}
          >
            {body}
            {/* Positioned out of the line box, so the badge never adds a gap inside the sentence. */}
            {badge ? <span aria-hidden="true" data-note-badge className="pointer-events-none absolute -top-1 -right-1 h-1.5 w-1.5 rounded-full bg-accent" /> : null}
          </span>
        );
      })}
    </>
  );
}
