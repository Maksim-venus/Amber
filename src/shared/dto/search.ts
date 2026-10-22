import { z } from "zod";
import { segmentIdSchema } from "../ids.ts";

const idSchema = z.string().min(1);
const msSchema = z.number().int().nonnegative();

/** Upper bound of a search query's length; longer input is a client error, not a query. */
export const SEARCH_QUERY_MAX_CHARS = 200;

/** `GET /api/search?q=&scope=`; `scope` defaults to `global`. */
export const searchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(SEARCH_QUERY_MAX_CHARS),
    scope: z.string().min(1).optional(),
  })
  .strict();
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/**
 * A highlighted span of `snippet`: `[start, end)` in UTF-16 code units, the unit of
 * JavaScript string indices. Hits carry offsets rather than HTML.
 */
export const searchRangeSchema = z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() });
export type SearchRange = z.infer<typeof searchRangeSchema>;

const hitText = { snippet: z.string(), ranges: z.array(searchRangeSchema) };

/** A Content matched by its title or by an imported reference text; reference-text hits group here. */
export const contentHitDtoSchema = z.object({
  contentId: idSchema,
  title: z.string().optional(),
  matchedIn: z.enum(["title", "reference"]),
  ...hitText,
});
export type ContentHitDto = z.infer<typeof contentHitDtoSchema>;

/** A sentence of a Content's primary revision; opens `?tab=transcript&revision=&segment=`. */
export const segmentHitDtoSchema = z.object({
  contentId: idSchema,
  contentTitle: z.string().optional(),
  transcriptRevisionId: idSchema,
  segmentId: segmentIdSchema,
  startMs: msSchema,
  ...hitText,
});
export type SegmentHitDto = z.infer<typeof segmentHitDtoSchema>;

/** The current revision of one of a Content's summaries. */
export const summaryHitDtoSchema = z.object({
  contentId: idSchema,
  contentTitle: z.string().optional(),
  artifactId: idSchema,
  templateId: idSchema,
  summaryRevisionId: idSchema,
  ...hitText,
});
export type SummaryHitDto = z.infer<typeof summaryHitDtoSchema>;

/** A Collection matched by its name or description; only in the `global` scope. */
export const collectionHitDtoSchema = z.object({
  collectionId: idSchema,
  name: z.string(),
  ...hitText,
});
export type CollectionHitDto = z.infer<typeof collectionHitDtoSchema>;

/** Each group holds at most `SEARCH_GROUP_LIMIT` hits, best first. */
export const searchResultDtoSchema = z.object({
  contents: z.array(contentHitDtoSchema),
  segments: z.array(segmentHitDtoSchema),
  summaries: z.array(summaryHitDtoSchema),
  collections: z.array(collectionHitDtoSchema),
});
export type SearchResultDto = z.infer<typeof searchResultDtoSchema>;
