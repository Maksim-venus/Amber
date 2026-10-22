import { z } from "zod";
import { contentSourceDtoSchema } from "./content.ts";

const idSchema = z.string().min(1);
const epochMsSchema = z.number().int().nonnegative();

/**
 * One Content in the trash (`GET /api/trash`). `purgeAt` is
 * `trashedAt + TRASH_RETENTION_DAYS`; `expired` means it can no longer be restored and only
 * waits for the sweep. `mediaBytes` sums the Content's available files Amber would delete.
 */
export const trashItemDtoSchema = z.object({
  id: idSchema,
  title: z.string().exactOptional(),
  source: contentSourceDtoSchema,
  coverUrl: z.string().exactOptional(),
  durationMs: z.number().int().nonnegative().exactOptional(),
  trashedAt: epochMsSchema,
  purgeAt: epochMsSchema,
  expired: z.boolean(),
  mediaBytes: z.number().int().nonnegative(),
});
export type TrashItemDto = z.infer<typeof trashItemDtoSchema>;

export const trashListDtoSchema = z.object({
  items: z.array(trashItemDtoSchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().exactOptional(),
});
export type TrashListDto = z.infer<typeof trashListDtoSchema>;

/** `DELETE /api/trash`: every entry is purged in its own transaction; failures do not stop the rest. */
export const trashPurgeAllDtoSchema = z.object({
  purgedIds: z.array(idSchema),
  failed: z.array(z.object({ contentId: idSchema, code: z.string().min(1) })),
});
export type TrashPurgeAllDto = z.infer<typeof trashPurgeAllDtoSchema>;
