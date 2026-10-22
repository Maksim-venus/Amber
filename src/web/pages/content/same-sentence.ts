import { useQuery } from "@tanstack/react-query";
import { segmentMapDtoSchema } from "../../../shared/dto/transcript.ts";
import { useApi } from "../../api/context.tsx";
import { useContentPage } from "./content-context.tsx";

export interface LocatedSegment {
  segmentId: string | undefined;
  /** The selection has no counterpart in this revision: say so, never jump elsewhere. */
  unmatched: boolean;
}

/**
 * The page selection expressed in `revisionId` by the same-sentence rule: the
 * server maps across revisions by lineage, then overlap, then nearest start within
 * SEEK_MATCH_TOLERANCE_MS; `none` is reported as unmatched.
 */
export function useLocatedSegment(revisionId: string | undefined): LocatedSegment {
  const client = useApi();
  const { selection } = useContentPage();
  const crossRevision = selection !== undefined && revisionId !== undefined && selection.revisionId !== revisionId;
  const mapped = useQuery({
    queryKey: ["segment-map", selection?.segmentId, revisionId],
    queryFn: () =>
      client.get(
        `/api/transcript/segments/${encodeURIComponent(selection?.segmentId ?? "")}/map?targetRevision=${encodeURIComponent(revisionId ?? "")}`,
        segmentMapDtoSchema,
      ),
    enabled: crossRevision,
    staleTime: Infinity,
  });
  if (selection === undefined || revisionId === undefined) {
    return { segmentId: undefined, unmatched: false };
  }
  if (!crossRevision) {
    return { segmentId: selection.segmentId, unmatched: false };
  }
  if (mapped.data === undefined) {
    return { segmentId: undefined, unmatched: false };
  }
  return mapped.data.method === "none" || mapped.data.segmentId === null
    ? { segmentId: undefined, unmatched: true }
    : { segmentId: mapped.data.segmentId, unmatched: false };
}
