import { z } from "zod";
import { modelPricingSchema } from "../model-pricing.ts";

/** What a registered model is for; Amber calls none of them. */
export const OTHER_MODEL_KINDS = ["tts", "image_generation", "video_generation", "other"] as const;
export type OtherModelKind = (typeof OTHER_MODEL_KINDS)[number];

/** Longest note on an other-models profile, in characters. */
export const OTHER_MODEL_NOTE_MAX_CHARS = 500;

const nameSchema = z.string().trim().min(1).max(100);
const modelIdSchema = z.string().trim().min(1).max(200);
const noteSchema = z.string().trim().min(1).max(OTHER_MODEL_NOTE_MAX_CHARS);

export const otherModelDtoSchema = z.object({
  modelId: z.string().min(1),
  kind: z.enum(OTHER_MODEL_KINDS),
  pricing: modelPricingSchema.exactOptional(),
});
export type OtherModelDto = z.infer<typeof otherModelDtoSchema>;

/**
 * One entry of the user's register of models Amber does not call (TTS, image or video
 * generation …): a name, a note and models with their kind and price. No key, no address.
 */
export const otherModelProfileDtoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  note: z.string().exactOptional(),
  models: z.array(otherModelDtoSchema),
  createdAt: z.number().int().nonnegative(),
});
export type OtherModelProfileDto = z.infer<typeof otherModelProfileDtoSchema>;

/** `GET /api/other-models`: in the user's order. */
export const otherModelProfileListDtoSchema = z.object({ items: z.array(otherModelProfileDtoSchema) });
export type OtherModelProfileListDto = z.infer<typeof otherModelProfileListDtoSchema>;

/** A model in a create or update request; a kept model keeps its price. */
export const otherModelInputSchema = z
  .object({
    modelId: modelIdSchema,
    kind: z.enum(OTHER_MODEL_KINDS),
  })
  .strict();
export type OtherModelInput = z.infer<typeof otherModelInputSchema>;

/** `POST /api/other-models`: model ids must not repeat. */
export const otherModelProfileCreateSchema = z
  .object({
    name: nameSchema,
    note: noteSchema.exactOptional(),
    models: z.array(otherModelInputSchema),
  })
  .strict();
export type OtherModelProfileCreate = z.infer<typeof otherModelProfileCreateSchema>;

/** `PATCH /api/other-models/:id`: `models` replaces the list in the given order; `note: null` clears it. */
export const otherModelProfilePatchSchema = z
  .object({
    name: nameSchema.exactOptional(),
    note: noteSchema.nullable().exactOptional(),
    models: z.array(otherModelInputSchema).exactOptional(),
  })
  .strict();
export type OtherModelProfilePatch = z.infer<typeof otherModelProfilePatchSchema>;

/** `PUT /api/other-models/order`: every profile of the user exactly once, in the new order. */
export const otherModelOrderRequestSchema = z.object({ profileIds: z.array(z.string().min(1)).min(1) }).strict();
export type OtherModelOrderRequest = z.infer<typeof otherModelOrderRequestSchema>;
