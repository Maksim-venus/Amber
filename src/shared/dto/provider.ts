import { z } from "zod";
import { CREDENTIAL_STATUSES, LLM_PROTOCOLS, TRI_STATES } from "../enums.ts";
import { modelPricingSchema } from "../model-pricing.ts";

const triSchema = z.enum(TRI_STATES);
const tokenCountSchema = z.number().int().positive();

export const capabilityFlagsSchema = z.object({
  stream: triSchema,
  tools: triSchema,
  structuredOutput: triSchema,
  vision: triSchema,
  audioInput: triSchema,
  reasoning: triSchema,
});
export type CapabilityFlagsDto = z.infer<typeof capabilityFlagsSchema>;

export const capabilityLimitsSchema = z.object({
  contextWindowTokens: tokenCountSchema.exactOptional(),
  maxOutputTokens: tokenCountSchema.exactOptional(),
});

/** The three layers as stored, plus the field-wise effective value. */
export const modelCapabilityDtoSchema = z.object({
  modelId: z.string().min(1),
  flags: z.object({
    declared: capabilityFlagsSchema,
    observed: capabilityFlagsSchema.partial().exactOptional(),
    userOverride: capabilityFlagsSchema.partial().exactOptional(),
  }),
  limits: z.object({
    declared: capabilityLimitsSchema,
    observed: capabilityLimitsSchema.exactOptional(),
    userOverride: capabilityLimitsSchema.exactOptional(),
  }),
  observedAt: z.number().int().exactOptional(),
  effective: z.object({ flags: capabilityFlagsSchema, limits: capabilityLimitsSchema }),
  /** The user's own price; display only, outside the capability layers. */
  pricing: modelPricingSchema.exactOptional(),
});
export type ModelCapabilityDto = z.infer<typeof modelCapabilityDtoSchema>;

/** Never carries the key; `hasCredential` is `credentialStatus !== "missing"`. */
export const providerProfileDtoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  protocol: z.enum(LLM_PROTOCOLS),
  baseURL: z.string().min(1),
  models: z.array(modelCapabilityDtoSchema),
  createdAt: z.number().int(),
  credentialStatus: z.enum(CREDENTIAL_STATUSES),
  hasCredential: z.boolean(),
});
export type ProviderProfileDto = z.infer<typeof providerProfileDtoSchema>;

export const providerListDtoSchema = z.object({ items: z.array(providerProfileDtoSchema) });
export type ProviderListDto = z.infer<typeof providerListDtoSchema>;

/** `PUT /api/providers/order`: every profile of the user exactly once, in the new order. */
export const providerOrderRequestSchema = z.object({ profileIds: z.array(z.string().min(1)).min(1) }).strict();
export type ProviderOrderRequest = z.infer<typeof providerOrderRequestSchema>;

/** `contextWindowTokens` is required because probing cannot measure it. */
export const providerModelInputSchema = z
  .object({
    modelId: z.string().trim().min(1),
    contextWindowTokens: tokenCountSchema,
    maxOutputTokens: tokenCountSchema.exactOptional(),
  })
  .strict();

export const createProviderRequestSchema = z
  .object({
    name: z.string().trim().min(1),
    protocol: z.enum(LLM_PROTOCOLS),
    baseURL: z.string().trim().min(1),
    models: z.array(providerModelInputSchema),
  })
  .strict();
export type CreateProviderRequest = z.infer<typeof createProviderRequestSchema>;

/** `models` replaces the whole list; models kept by id keep their probed and overridden layers. */
export const updateProviderRequestSchema = z
  .object({
    name: z.string().trim().min(1).exactOptional(),
    baseURL: z.string().trim().min(1).exactOptional(),
    models: z.array(providerModelInputSchema).exactOptional(),
  })
  .strict();
export type UpdateProviderRequest = z.infer<typeof updateProviderRequestSchema>;

/** Each present layer replaces the stored `userOverride` layer; a `null` field clears it. */
export const modelOverrideRequestSchema = z
  .object({
    flags: z
      .object({
        stream: triSchema.nullable(),
        tools: triSchema.nullable(),
        structuredOutput: triSchema.nullable(),
        vision: triSchema.nullable(),
        audioInput: triSchema.nullable(),
        reasoning: triSchema.nullable(),
      })
      .partial()
      .strict()
      .exactOptional(),
    limits: z
      .object({ contextWindowTokens: tokenCountSchema.nullable(), maxOutputTokens: tokenCountSchema.nullable() })
      .partial()
      .strict()
      .exactOptional(),
  })
  .strict();
export type ModelOverrideRequest = z.infer<typeof modelOverrideRequestSchema>;

export const probeRequestSchema = z.object({ modelId: z.string().min(1) }).strict();

/** What "test connection" measured and wrote back as the model's `observed` flags. */
export const probeResultDtoSchema = z.object({
  modelId: z.string().min(1),
  observed: capabilityFlagsSchema.pick({ stream: true, structuredOutput: true, tools: true }),
  latencyMs: z.number().nonnegative(),
  observedAt: z.number().int(),
});
export type ProbeResultDto = z.infer<typeof probeResultDtoSchema>;
