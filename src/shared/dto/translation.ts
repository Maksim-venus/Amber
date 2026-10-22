import { z } from "zod";
import { STALE_REASONS } from "./chapter.ts";
import { transcriptRevisionDtoSchema } from "./content.ts";
import { languageTagSchema } from "./import.ts";
import { modelRefSchema } from "./model-ref.ts";

const idSchema = z.string().min(1);

/**
 * `POST /api/contents/:id/translations`. The source defaults to
 * the primary transcript and is frozen at submission; languages are normalized and
 * de-duplicated by the server.
 */
export const translationRequestSchema = z
  .object({
    targetLanguages: z.array(languageTagSchema).min(1),
    modelRef: modelRefSchema.exactOptional(),
    sourceRevisionId: idSchema.exactOptional(),
  })
  .strict();
export type TranslationRequest = z.infer<typeof translationRequestSchema>;

/**
 * One target language: its current `translated` revision and every translated revision
 * in that language, oldest first. A translation is stale when its parent is no longer the
 * primary transcript.
 */
export const translationEntryDtoSchema = z.object({
  artifactId: idSchema,
  targetLanguage: z.string(),
  current: transcriptRevisionDtoSchema.exactOptional(),
  revisions: z.array(transcriptRevisionDtoSchema),
  stale: z.boolean(),
  staleReason: z.enum(STALE_REASONS).exactOptional(),
});
export type TranslationEntryDto = z.infer<typeof translationEntryDtoSchema>;

/** `GET /api/contents/:id/translations`: per-language translations and the unfinished translate Tasks. */
export const translationsDtoSchema = z.object({
  translations: z.array(translationEntryDtoSchema),
  activeTasks: z.array(z.object({ taskId: idSchema, targetLanguages: z.array(z.string()) })),
});
export type TranslationsDto = z.infer<typeof translationsDtoSchema>;
