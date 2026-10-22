import { z } from "zod";

/** "Which model of which Profile"; both parts are opaque identifiers. */
export const modelRefSchema = z
  .object({
    providerProfileId: z.string().min(1),
    modelId: z.string().min(1),
  })
  .strict();
export type ModelRefDto = z.infer<typeof modelRefSchema>;

/**
 * "Which model of which ASR profile": what the user picks to transcribe
 * with, a default names, and a Task freezes.
 */
export const asrModelRefSchema = z
  .object({
    asrProfileId: z.string().min(1),
    modelId: z.string().min(1),
  })
  .strict();
export type AsrModelRefDto = z.infer<typeof asrModelRefSchema>;
