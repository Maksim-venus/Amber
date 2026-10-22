import { z } from "zod";
import { modelRefSnapshotDtoSchema } from "./usage.ts";

const idSchema = z.string().min(1);
const msSchema = z.number().int().nonnegative();

/** Why a derived artifact is stale; chapters only ever report `transcript_changed`. */
export const STALE_REASONS = ["transcript_changed", "chapters_changed", "member_changed", "order_changed"] as const;
export type StaleReason = (typeof STALE_REASONS)[number];

export const chapterEntryDtoSchema = z.object({
  startMs: msSchema,
  endMs: msSchema,
  title: z.string(),
  summary: z.string().exactOptional(),
  startSegmentId: idSchema.exactOptional(),
});

/** A chapter revision with its derived freshness; platform chapters are never stale. */
export const chapterRevisionDtoSchema = z.object({
  id: idSchema,
  artifactId: idSchema,
  origin: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("platform") }),
    z.object({ kind: z.literal("ai"), transcriptRevisionId: idSchema }),
  ]),
  chapters: z.array(chapterEntryDtoSchema),
  modelRef: modelRefSnapshotDtoSchema.exactOptional(),
  promptRef: z.object({ id: idSchema, version: z.number().int().positive() }).exactOptional(),
  quality: z.enum(["normal", "degraded"]),
  qualityReasons: z.array(z.string()),
  stale: z.boolean(),
  staleReason: z.enum(STALE_REASONS).exactOptional(),
  createdAt: msSchema,
});
export type ChapterRevisionDto = z.infer<typeof chapterRevisionDtoSchema>;

/**
 * `GET /api/contents/:id/chapters`: the current revision, every revision to switch to
 * (oldest first) and the unfinished Task working on chapters, if any.
 */
export const chaptersDtoSchema = z.object({
  artifactId: idSchema.exactOptional(),
  current: chapterRevisionDtoSchema.exactOptional(),
  revisions: z.array(chapterRevisionDtoSchema),
  activeTaskId: idSchema.exactOptional(),
});
export type ChaptersDto = z.infer<typeof chaptersDtoSchema>;

/** `PUT /api/contents/:id/chapters/current`; may switch back to platform chapters. */
export const chaptersCurrentRequestSchema = z.object({ revisionId: idSchema }).strict();
export type ChaptersCurrentRequest = z.infer<typeof chaptersCurrentRequestSchema>;
