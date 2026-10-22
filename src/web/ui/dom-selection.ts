/** The element a node is, or sits in (a text node's parent). */
export function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

/**
 * The sentences (`[data-segment-id]` inside `region`) the selection shares text with. Judged
 * by the selected text rather than by the end points, because a drag across a whole sentence
 * often ends at offset 0 of the next one (or starts at the end of the previous one) without
 * selecting anything there.
 */
export function coveredSentences(range: Range, region: Element): HTMLElement[] {
  const container = elementOf(range.commonAncestorContainer);
  const own = container?.closest<HTMLElement>("[data-segment-id]");
  if (own != null) return region.contains(own) ? [own] : [];
  return Array.from(region.querySelectorAll<HTMLElement>("[data-segment-id]")).filter((sentence) => {
    if (!range.intersectsNode(sentence)) return false;
    const part = document.createRange();
    part.selectNodeContents(sentence);
    if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) part.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset);
    return part.toString().trim() !== "";
  });
}

/** One end of a selection: a sentence and a UTF-16 offset into its text. */
export interface SentencePoint {
  segmentId: string;
  offset: number;
}

/** A selection as sentence points of one revision, frozen when the user lets go. */
export interface SelectionBounds {
  revisionId: string;
  start: SentencePoint;
  end: SentencePoint;
}

/**
 * The UTF-16 offset of a boundary point inside `root`'s text: the length of every text node
 * before it. A point on an element boundary (between children) counts the text of the
 * children before it, so a sentence split by search `<mark>`s or note runs measures the same
 * as its plain text.
 */
export function textOffsetIn(root: Node, container: Node, offset: number): number {
  const point = document.createRange();
  point.setStart(container, offset);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    if (text === container) return total + offset;
    // The end of this text node lies before (or at) the point: it counts in full.
    if (point.comparePoint(text, text.length) <= 0) total += text.length;
    else break;
  }
  return total;
}

/** The plain text length of a sentence element. */
function textLength(sentence: Element): number {
  let total = 0;
  const walker = document.createTreeWalker(sentence, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) total += (node as Text).length;
  return total;
}

/**
 * Where a selection starts and ends in sentence terms, for a reading view that takes notes
 * (an element with `data-notes` naming its revision with `data-revision-id`). The first and
 * last sentences are those the selection shares text with; an end outside its sentence
 * counts as that sentence's edge. Undefined outside such a view or without a sentence.
 */
export function selectionBounds(range: Range): SelectionBounds | undefined {
  const root = elementOf(range.commonAncestorContainer)?.closest<HTMLElement>("[data-notes]");
  const revisionId = root?.closest<HTMLElement>("[data-revision-id]")?.dataset["revisionId"];
  if (root == null || revisionId === undefined) return undefined;
  const sentences = coveredSentences(range, root);
  const first = sentences[0];
  const last = sentences.at(-1);
  const firstId = first?.dataset["segmentId"];
  const lastId = last?.dataset["segmentId"];
  if (first === undefined || last === undefined || firstId === undefined || lastId === undefined) return undefined;
  const startOffset = first.contains(range.startContainer) ? textOffsetIn(first, range.startContainer, range.startOffset) : 0;
  const endOffset = last.contains(range.endContainer) ? textOffsetIn(last, range.endContainer, range.endOffset) : textLength(last);
  return { revisionId, start: { segmentId: firstId, offset: startOffset }, end: { segmentId: lastId, offset: endOffset } };
}
