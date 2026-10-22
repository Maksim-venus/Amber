import type { CitationDto } from "../../../shared/dto/citation.ts";
import type { CollectionSummaryRevisionDto } from "../../../shared/dto/collection.ts";

/**
 * Where a collection-summary citation leads: the member Content whose frozen input
 * transcript the cited segment belongs to, opened on that revision at that sentence.
 * Undefined when the segment is not one of the revision's citations or its transcript is
 * not among the frozen inputs.
 */
export function citationHref(
  segmentId: string,
  revision: Pick<CollectionSummaryRevisionDto, "citations" | "inputItems" | "partials">,
): string | undefined {
  const citation = findCitation(segmentId, revision);
  if (citation === undefined) {
    return undefined;
  }
  const input = revision.inputItems.find((item) => item.transcriptRevisionId === citation.transcriptRevisionId);
  if (input === undefined) {
    return undefined;
  }
  const query = new URLSearchParams({ tab: "transcript", revision: citation.transcriptRevisionId, segment: segmentId });
  return `/contents/${encodeURIComponent(input.contentId)}?${query.toString()}`;
}

function findCitation(
  segmentId: string,
  revision: Pick<CollectionSummaryRevisionDto, "citations" | "partials">,
): CitationDto | undefined {
  return [...revision.citations, ...revision.partials.flatMap((partial) => partial.citations)].find((citation) => citation.segmentId === segmentId);
}
