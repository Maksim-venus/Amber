import { SEEK_MATCH_TOLERANCE_MS } from "../../shared/defaults.ts";
import type { NoteAnchor } from "./note.ts";
import type { TranscriptRevision } from "./transcript.ts";

type MapRevision = Pick<TranscriptRevision, "id" | "parentRevisionId">;
/** What mapping needs from a sentence; a `TranscriptSegment` fits. */
export interface NoteMapSentence {
  id: string;
  ordinal: number;
  startMs: number;
  endMs: number;
  text: string;
  /** Sentences of the parent revision this one was made from. */
  sourceSegmentIds: readonly string[];
}

/** A note as shown on a revision: whole sentences unless `exact`. */
export interface NoteView {
  segments: Array<{ segmentId: string; startOffset: number; endOffset: number }>;
  exact: boolean;
}

/**
 * Lookups over one revision's sentences. Built once per revision and shared by every note
 * mapped in one request, so mapping many notes costs one pass over each revision involved
 * plus the frontier work of each note.
 */
export class RevisionSentences {
  /** In `ordinal` order. */
  readonly sentences: readonly NoteMapSentence[];
  private readonly positions = new Map<string, number>();
  private children: Map<string, NoteMapSentence[]> | undefined;
  private timeline: { byStart: NoteMapSentence[]; maxEnd: number[] } | undefined;

  constructor(sentences: readonly NoteMapSentence[]) {
    this.sentences = sentences;
    sentences.forEach((sentence, index) => this.positions.set(sentence.id, index));
  }

  get(segmentId: string): NoteMapSentence | undefined {
    const position = this.positions.get(segmentId);
    return position === undefined ? undefined : this.sentences[position];
  }

  /** Index in reading order, or `undefined` for a sentence of another revision. */
  position(segmentId: string): number | undefined {
    return this.positions.get(segmentId);
  }

  /** The sentences of this revision that name `parentSegmentId` (a sentence of the parent revision) as a source. */
  childrenOf(parentSegmentId: string): readonly NoteMapSentence[] {
    if (this.children === undefined) {
      const children = new Map<string, NoteMapSentence[]>();
      for (const sentence of this.sentences) {
        for (const source of new Set(sentence.sourceSegmentIds)) {
          const list = children.get(source);
          if (list === undefined) {
            children.set(source, [sentence]);
          } else {
            list.push(sentence);
          }
        }
      }
      this.children = children;
    }
    return this.children.get(parentSegmentId) ?? [];
  }

  /**
   * The sentence overlapping `[startMs, endMs)` the most (lowest ordinal on a tie), else the
   * one starting nearest to `startMs` within `SEEK_MATCH_TOLERANCE_MS`. Sentences are kept
   * sorted by start with a running maximum of their ends, so the overlap scan stops as soon
   * as nothing earlier can reach `startMs`: `O(log n)` plus the overlapping candidates.
   */
  nearestInTime(startMs: number, endMs: number): NoteMapSentence | undefined {
    const { byStart, maxEnd } = this.timelineIndex();
    // First sentence starting at or after `endMs`: everything before it starts in time to overlap.
    let index = lowerBound(byStart, endMs) - 1;
    let best: { sentence: NoteMapSentence; overlap: number } | undefined;
    for (; index >= 0 && (maxEnd[index] ?? 0) > startMs; index -= 1) {
      const sentence = byStart[index] as NoteMapSentence;
      const overlap = Math.min(sentence.endMs, endMs) - Math.max(sentence.startMs, startMs);
      if (overlap > 0 && (best === undefined || overlap > best.overlap || (overlap === best.overlap && sentence.ordinal < best.sentence.ordinal))) {
        best = { sentence, overlap };
      }
    }
    if (best !== undefined) {
      return best.sentence;
    }
    const at = lowerBound(byStart, startMs);
    let nearest: { sentence: NoteMapSentence; distance: number } | undefined;
    const consider = (sentence: NoteMapSentence | undefined): void => {
      if (sentence === undefined) {
        return;
      }
      const distance = Math.abs(sentence.startMs - startMs);
      if (
        distance <= SEEK_MATCH_TOLERANCE_MS &&
        (nearest === undefined || distance < nearest.distance || (distance === nearest.distance && sentence.ordinal < nearest.sentence.ordinal))
      ) {
        nearest = { sentence, distance };
      }
    };
    consider(byStart[at]);
    // The latest start before `startMs`, and every sentence sharing that start.
    const before = byStart[at - 1];
    for (let back = at - 1; back >= 0 && byStart[back]?.startMs === before?.startMs; back -= 1) {
      consider(byStart[back]);
    }
    return nearest?.sentence;
  }

  private timelineIndex(): { byStart: NoteMapSentence[]; maxEnd: number[] } {
    if (this.timeline === undefined) {
      const byStart = [...this.sentences].sort((a, b) => a.startMs - b.startMs || a.ordinal - b.ordinal);
      const maxEnd: number[] = [];
      let running = -Infinity;
      for (const sentence of byStart) {
        running = Math.max(running, sentence.endMs);
        maxEnd.push(running);
      }
      this.timeline = { byStart, maxEnd };
    }
    return this.timeline;
  }
}

/** Index of the first sentence whose start is at or after `ms`. */
function lowerBound(byStart: readonly NoteMapSentence[], ms: number): number {
  let low = 0;
  let high = byStart.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((byStart[middle]?.startMs ?? Infinity) < ms) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

export interface NoteMapInput {
  anchor: NoteAnchor;
  targetRevisionId: string;
  /** Every revision of the Content, by id. */
  revisions: ReadonlyMap<string, MapRevision>;
  /** The sentences of one revision of the Content; callers cache them for the whole request. */
  sentencesOf(revisionId: string): RevisionSentences;
}

/**
 * Whether a frontier sentence lies wholly inside the note (`same`) or also holds text from
 * outside it (`wider`).
 */
type Containment = "same" | "wider";

/**
 * Where a note anchored on one revision shows on another revision of the same Content,
 * or `null` when it cannot be placed there.
 *
 * Within one lineage (the revisions share an ancestor) only `sourceSegmentIds` links are
 * followed, generation by generation, up from the anchor revision to the common ancestor
 * and down to the target. Each frontier sentence carries whether it lies wholly inside the
 * note: going up, a parent is wholly inside when all of its children in that generation
 * are; going down, a child is when all of its sources are. A sentence that also holds
 * outside text and was then split, or came from several sources on the way up, cannot say
 * which part holds the note and is dropped, as is one whose link chain breaks. Time is
 * never consulted inside a lineage: a broken chain means the text was rewritten, and a
 * neighbour that happens to overlap in time would mark the wrong words. Across lineages
 * (no shared ancestor, e.g. platform captions against an ASR original) each anchored
 * sentence takes the target sentence overlapping it most in time.
 *
 * Mapped sentences come back in reading order without filling gaps. The view is `exact`,
 * carrying the anchor's character offsets, only on the anchor revision itself or when the
 * lineage maps sentence for sentence onto identical text; otherwise whole sentences.
 */
export function mapNoteRange(input: NoteMapInput): NoteView | null {
  const { anchor } = input;
  const source = input.sentencesOf(anchor.transcriptRevisionId);
  const range = anchoredRange(source, anchor);
  if (range.length === 0) {
    return null;
  }
  if (input.targetRevisionId === anchor.transcriptRevisionId) {
    return { segments: withOffsets(range, anchor), exact: true };
  }
  const target = input.sentencesOf(input.targetRevisionId);
  const sourceChain = ancestry(anchor.transcriptRevisionId, input.revisions);
  const targetChain = ancestry(input.targetRevisionId, input.revisions);
  const targetSet = new Set(targetChain);
  const ancestor = sourceChain.find((id) => targetSet.has(id));
  if (ancestor === undefined) {
    const picked = new Map<string, NoteMapSentence>();
    for (const sentence of range) {
      const match = target.nearestInTime(sentence.startMs, sentence.endMs);
      if (match !== undefined) {
        picked.set(match.id, match);
      }
    }
    return wholeSentences(target, [...picked.values()]);
  }

  let frontier = new Map<string, Containment>(range.map((sentence) => [sentence.id, "same"]));
  for (let hop = 0; sourceChain[hop] !== ancestor && frontier.size > 0; hop += 1) {
    frontier = stepUp(frontier, input.sentencesOf(sourceChain[hop] as string), input.sentencesOf(sourceChain[hop + 1] as string));
  }
  const down = targetChain.slice(0, targetChain.indexOf(ancestor)).reverse();
  for (const revisionId of down) {
    if (frontier.size === 0) {
      break;
    }
    frontier = stepDown(frontier, input.sentencesOf(revisionId));
  }

  const mapped: NoteMapSentence[] = [];
  for (const segmentId of frontier.keys()) {
    const sentence = target.get(segmentId);
    if (sentence !== undefined) {
      mapped.push(sentence);
    }
  }
  if (mapped.length === 0) {
    return null;
  }
  mapped.sort((a, b) => (target.position(a.id) ?? 0) - (target.position(b.id) ?? 0));
  const exact =
    mapped.length === range.length &&
    mapped.every((sentence, index) => frontier.get(sentence.id) === "same" && sentence.text === range[index]?.text);
  return exact ? { segments: withOffsets(mapped, anchor), exact: true } : wholeSentences(target, mapped);
}

/** The anchor revision's sentences from the start to the end sentence; empty when the anchor no longer resolves. */
function anchoredRange(source: RevisionSentences, anchor: NoteAnchor): readonly NoteMapSentence[] {
  const from = source.position(anchor.startSegmentId);
  const to = source.position(anchor.endSegmentId);
  return from === undefined || to === undefined || from > to ? [] : source.sentences.slice(from, to + 1);
}

/**
 * One generation up: from the frontier in `child` to the sentences of its parent revision.
 * The parents reached are collected first, so one reached along several paths counts once.
 */
function stepUp(frontier: ReadonlyMap<string, Containment>, child: RevisionSentences, parent: RevisionSentences): Map<string, Containment> {
  const parents = new Set<string>();
  for (const [segmentId, state] of frontier) {
    const sources = child.get(segmentId)?.sourceSegmentIds ?? [];
    // No source: the chain breaks here. Wider and merged: which source holds the note is unknowable.
    if (sources.length === 0 || (state === "wider" && sources.length > 1)) {
      continue;
    }
    for (const sourceId of sources) {
      if (parent.get(sourceId) !== undefined) {
        parents.add(sourceId);
      }
    }
  }
  const next = new Map<string, Containment>();
  for (const parentId of parents) {
    const whole = child.childrenOf(parentId).every((sentence) => frontier.get(sentence.id) === "same");
    next.set(parentId, whole ? "same" : "wider");
  }
  return next;
}

/** One generation down: from the frontier in the parent revision to the sentences of `child`. */
function stepDown(frontier: ReadonlyMap<string, Containment>, child: RevisionSentences): Map<string, Containment> {
  const children = new Map<string, NoteMapSentence>();
  for (const segmentId of frontier.keys()) {
    for (const sentence of child.childrenOf(segmentId)) {
      children.set(sentence.id, sentence);
    }
  }
  const next = new Map<string, Containment>();
  for (const sentence of children.values()) {
    const sources = sentence.sourceSegmentIds;
    if (sources.every((sourceId) => frontier.get(sourceId) === "same")) {
      next.set(sentence.id, "same");
      continue;
    }
    // A sentence holding outside text that was split again: which piece holds the note is unknowable.
    const resplit = sources.some((sourceId) => frontier.get(sourceId) === "wider" && child.childrenOf(sourceId).length > 1);
    if (!resplit) {
      next.set(sentence.id, "wider");
    }
  }
  return next;
}

/** The revision and its ancestors, nearest first; stops at a missing parent or a cycle. */
function ancestry(revisionId: string, revisions: ReadonlyMap<string, MapRevision>): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  for (let id: string | undefined = revisionId; id !== undefined && !seen.has(id); id = revisions.get(id)?.parentRevisionId) {
    if (!revisions.has(id)) {
      break;
    }
    seen.add(id);
    chain.push(id);
  }
  return chain;
}

/** The anchor's offsets on the first and last sentence, whole sentences in between. */
function withOffsets(sentences: readonly NoteMapSentence[], anchor: NoteAnchor): NoteView["segments"] {
  const last = sentences.length - 1;
  return sentences.map((sentence, index) => ({
    segmentId: sentence.id,
    startOffset: index === 0 ? anchor.startOffset : 0,
    endOffset: index === last ? anchor.endOffset : sentence.text.length,
  }));
}

function wholeSentences(target: RevisionSentences, sentences: readonly NoteMapSentence[]): NoteView | null {
  if (sentences.length === 0) {
    return null;
  }
  const ordered = [...sentences].sort((a, b) => (target.position(a.id) ?? 0) - (target.position(b.id) ?? 0));
  return { segments: ordered.map((sentence) => ({ segmentId: sentence.id, startOffset: 0, endOffset: sentence.text.length })), exact: false };
}
