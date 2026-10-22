import { z } from "zod";

/**
 * Billing units a user may price a model in. Each names its quantity and
 * scale; a new billing basis is one more member here. Prices are display-only: nothing
 * computes cost from them.
 */
export const PRICE_UNITS = [
  "input_tokens_per_million",
  "output_tokens_per_million",
  "cached_input_tokens_per_million",
  "audio_per_second",
  "audio_per_minute",
  "audio_per_hour",
  "characters_per_thousand",
  "characters_per_ten_thousand",
  "characters_per_million",
  "per_image",
  "video_per_second",
  "per_request",
] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];

export const PRICE_CURRENCIES = ["CNY", "USD"] as const;
export type PriceCurrency = (typeof PRICE_CURRENCIES)[number];

/** Which settings section a priced model belongs to; each offers the units that fit its models. */
export const PRICING_SCOPES = ["llm", "asr", "other"] as const;
export type PricingScope = (typeof PRICING_SCOPES)[number];

const TOKEN_UNITS = ["input_tokens_per_million", "output_tokens_per_million", "cached_input_tokens_per_million"] as const;
const AUDIO_UNITS = ["audio_per_second", "audio_per_minute", "audio_per_hour"] as const;

export const PRICE_UNITS_BY_SCOPE: Readonly<Record<PricingScope, readonly PriceUnit[]>> = {
  llm: [...TOKEN_UNITS, "per_request"],
  asr: [...TOKEN_UNITS, ...AUDIO_UNITS, "per_request"],
  other: PRICE_UNITS,
};

/** Most items one model's price may have. */
export const PRICE_ITEMS_MAX = 6;
/** Longest note on a price (free quota, tiers), in characters. */
export const PRICE_NOTE_MAX_CHARS = 200;

/**
 * A non-negative decimal kept as typed, so `0.00022` never shows as a float artifact:
 * up to 9 integer and 10 fraction digits.
 */
export const PRICE_AMOUNT_PATTERN = /^(0|[1-9]\d{0,8})(\.\d{1,10})?$/;

export const priceItemSchema = z
  .object({
    unit: z.enum(PRICE_UNITS),
    amount: z.string().regex(PRICE_AMOUNT_PATTERN),
  })
  .strict();
export type PriceItem = z.infer<typeof priceItemSchema>;

/** The user's own price of one model; never verified, never used to compute cost. */
export const modelPricingSchema = z
  .object({
    currency: z.enum(PRICE_CURRENCIES),
    items: z
      .array(priceItemSchema)
      .min(1)
      .max(PRICE_ITEMS_MAX)
      .refine((items) => new Set(items.map((item) => item.unit)).size === items.length, { message: "units must not repeat" }),
    note: z.string().trim().min(1).max(PRICE_NOTE_MAX_CHARS).exactOptional(),
  })
  .strict();
export type ModelPricing = z.infer<typeof modelPricingSchema>;

/** Whether every item of a price uses a unit its section offers. */
export function pricingFitsScope(pricing: ModelPricing, scope: PricingScope): boolean {
  const allowed = PRICE_UNITS_BY_SCOPE[scope];
  return pricing.items.every((item) => allowed.includes(item.unit));
}
