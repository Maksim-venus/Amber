import { z } from "zod";
import { NOTE_COMMENT_MAX_CHARS } from "../defaults.ts";
import { NOTE_COLORS, NOTE_MARKS } from "../enums.ts";

const idSchema = z.string().min(1);
const msSchema = z.number().int().nonnegative();
const offsetSchema = z.number().int().nonnegative();
/** Plain text; blank comments are rejected rather than stored. */
const commentSchema = z.string().trim().min(1).max(NOTE_COMMENT_MAX_CHARS);

/** Where a note lands in the revision being read: whole sentences unless `exact`. */
export const noteViewSchema = z.object({
  segments: z.array(z.object({ segmentId: idSchema, startOffset: offsetSchema, endOffset: offsetSchema })).min(1),
  exact: z.boolean(),
});
export type NoteViewDto = z.infer<typeof noteViewSchema>;

export const noteDtoSchema = z.object({
  id: idSchema,
  contentId: idSchema,
  contentTitle: z.string(),
  transcriptRevisionId: idSchema,
  startSegmentId: idSchema,
  startOffset: offsetSchema,
  endSegmentId: idSchema,
  endOffset: offsetSchema,
  /** Start time of the first anchored sentence. */
  startMs: msSchema,
  quote: z.string(),
  mark: z.enum(NOTE_MARKS),
  color: z.enum(NOTE_COLORS),
  comment: z.string().exactOptional(),
  createdAt: msSchema,
  updatedAt: msSchema,
  /** Present only when the list was asked for a `revision`; `null` = it cannot be placed there. */
  view: noteViewSchema.nullable().exactOptional(),
});
export type NoteDto = z.infer<typeof noteDtoSchema>;

/** `GET /api/contents/:id/notes`: in reading order. */
export const noteListDtoSchema = z.object({ items: z.array(noteDtoSchema) });
export type NoteListDto = z.infer<typeof noteListDtoSchema>;

export const noteGroupDtoSchema = z.object({
  contentId: idSchema,
  title: z.string(),
  count: z.number().int().positive(),
  latestAt: msSchema,
});
export type NoteGroupDto = z.infer<typeof noteGroupDtoSchema>;

/** `GET /api/notes/groups`: one row per Content with notes, latest first; `total` counts groups. */
export const noteGroupsDtoSchema = z.object({
  items: z.array(noteGroupDtoSchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().min(1).exactOptional(),
});
export type NoteGroupsDto = z.infer<typeof noteGroupsDtoSchema>;

/** `POST /api/contents/:id/notes`; the server checks the anchor and cuts `quote` itself. */
export const noteCreateRequestSchema = z
  .object({
    transcriptRevisionId: idSchema,
    startSegmentId: idSchema,
    startOffset: offsetSchema,
    endSegmentId: idSchema,
    endOffset: z.number().int().positive(),
    mark: z.enum(NOTE_MARKS),
    color: z.enum(NOTE_COLORS),
    comment: commentSchema.exactOptional(),
  })
  .strict();
export type NoteCreateRequest = z.infer<typeof noteCreateRequestSchema>;

/** `PATCH /api/notes/:id`; `comment: null` removes it. The anchor never changes. */
export const notePatchRequestSchema = z
  .object({
    mark: z.enum(NOTE_MARKS).exactOptional(),
    color: z.enum(NOTE_COLORS).exactOptional(),
    comment: commentSchema.nullable().exactOptional(),
  })
  .strict()
  .refine((body) => body.mark !== undefined || body.color !== undefined || body.comment !== undefined, {
    message: "nothing to change",
  });
export type NotePatchRequest = z.infer<typeof notePatchRequestSchema>;
