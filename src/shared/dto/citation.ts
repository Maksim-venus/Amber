import { z } from "zod";
import { segmentIdSchema } from "../ids.ts";

/**
 * Invariant: evidence is referenced as `transcriptRevisionId + segmentId` into an immutable
 * transcript revision, never by time or text alone, so a citation keeps resolving after later
 * revisions.
 */
export const citationDtoSchema = z.object({
  transcriptRevisionId: z.string().min(1),
  segmentId: segmentIdSchema,
});
export type CitationDto = z.infer<typeof citationDtoSchema>;
