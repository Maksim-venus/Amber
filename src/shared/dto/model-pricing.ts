import { z } from "zod";
import { modelPricingSchema } from "../model-pricing.ts";

/**
 * `PUT /api/{providers|asr-profiles|other-models}/:id/model-pricing`: set (or with `null`
 * clear) one model's price. The model id travels in the body because ids may contain `/`.
 */
export const modelPricingRequestSchema = z
  .object({
    modelId: z.string().min(1),
    pricing: modelPricingSchema.nullable(),
  })
  .strict();
export type ModelPricingRequest = z.infer<typeof modelPricingRequestSchema>;
