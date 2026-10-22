import { z } from "zod";
import { CACHE_MEDIA_TYPES } from "../cache-file-name.ts";
import { DISPLAY_NAME_MAX_CHARS } from "../defaults.ts";
import { BURN_MODES, CACHE_MEDIA_QUALITIES, SUBTITLE_DELIVERIES, SUBTITLE_VIDEO_CONTAINERS } from "../enums.ts";
import { subtitleStyleSchema } from "../subtitle-style.ts";

const idSchema = z.string().min(1);

/**
 * `POST /api/contents/:id/cache-media` [client]. `type` defaults to
 * `video`; `quality` is the height tier of a video (`CACHE_MEDIA_MAX_HEIGHT` when absent)
 * and is refused together with `audio`; `fileName` defaults to the Content's display title
 * and is cleaned and de-duplicated by the server.
 */
export const cacheMediaRequestSchema = z
  .object({
    type: z.enum(CACHE_MEDIA_TYPES).exactOptional(),
    quality: z.union(CACHE_MEDIA_QUALITIES.map((quality) => z.literal(quality))).exactOptional(),
    fileName: z.string().max(DISPLAY_NAME_MAX_CHARS).exactOptional(),
  })
  .strict()
  .refine((body) => !(body.type === "audio" && body.quality !== undefined), {
    message: "quality applies to video caches only",
    path: ["quality"],
  });
export type CacheMediaRequest = z.infer<typeof cacheMediaRequestSchema>;

/**
 * `POST /api/contents/:id/burn` [client], the subtitled video export: no output
 * path is accepted. `original` uses `revisionId`; `translation` the translation alone and
 * `bilingual` both lines, where `translationRevisionId` must be a translation whose parent is
 * `revisionId`. `delivery`, `container` and `style` come all together or not at all: without
 * them the request is the legacy fixed-style MP4 burn-in; a hard-subtitle export is MP4 only.
 */
export const burnRequestSchema = z
  .object({
    revisionId: idSchema,
    translationRevisionId: idSchema.exactOptional(),
    mode: z.enum(BURN_MODES),
    delivery: z.enum(SUBTITLE_DELIVERIES).exactOptional(),
    container: z.enum(SUBTITLE_VIDEO_CONTAINERS).exactOptional(),
    style: subtitleStyleSchema.exactOptional(),
  })
  .strict()
  .refine((body) => (body.mode === "original") === (body.translationRevisionId === undefined), {
    message: "translationRevisionId is required for translation and bilingual burns and only for them",
    path: ["translationRevisionId"],
  })
  .refine((body) => [body.delivery, body.container, body.style].every((field) => field === undefined) || [body.delivery, body.container, body.style].every((field) => field !== undefined), {
    message: "delivery, container and style are given together or not at all",
    path: ["delivery"],
  })
  .refine((body) => body.delivery !== "hard" || body.container === "mp4", {
    message: "a hard-subtitle export is MP4 only",
    path: ["container"],
  });
export type BurnRequest = z.infer<typeof burnRequestSchema>;

/** One burn product not yet saved out of the data directory (`GET /api/media/burn-outputs` [client]). */
export const burnOutputDtoSchema = z.object({
  assetId: idSchema,
  contentId: idSchema,
  taskId: idSchema,
  title: z.string().exactOptional(),
  /** `video/mp4` or `video/x-matroska`. */
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
});
export type BurnOutputDto = z.infer<typeof burnOutputDtoSchema>;

/** Oldest first. */
export const burnOutputListDtoSchema = z.array(burnOutputDtoSchema);
export type BurnOutputListDto = z.infer<typeof burnOutputListDtoSchema>;
