import { z } from "zod";

export const TERMINOLOGY_RULES = ["keep_original"] as const;

/** `global`, `collection:<id>` or `content:<id>`. */
export const terminologyScopeParamSchema = z.string().regex(/^(global|collection:[^:\s]+|content:[^:\s]+)$/);

export const terminologyEntryDtoSchema = z.object({
  id: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  term: z.string().min(1),
  normalizedKey: z.string().min(1),
  translation: z.string().min(1).exactOptional(),
  rule: z.enum(TERMINOLOGY_RULES).exactOptional(),
});

export const terminologyDtoSchema = z.object({
  scope: terminologyScopeParamSchema,
  entries: z.array(terminologyEntryDtoSchema),
});
export type TerminologyDto = z.infer<typeof terminologyDtoSchema>;

/**
 * Replaces the whole set; `ordinal` is the array index. Limits and duplicate keys are
 * checked by the server and rejected, never truncated.
 */
export const putTerminologyRequestSchema = z
  .object({
    entries: z.array(
      z
        .object({
          term: z.string(),
          translation: z.string().trim().min(1).exactOptional(),
          rule: z.enum(TERMINOLOGY_RULES).exactOptional(),
        })
        .strict(),
    ),
  })
  .strict();
export type PutTerminologyRequest = z.infer<typeof putTerminologyRequestSchema>;
