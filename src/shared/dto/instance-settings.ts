import { z } from "zod";
import { CONCURRENCY_PIPELINE_MAX } from "../defaults.ts";
import { UPLOAD_RETENTION_POLICIES } from "../enums.ts";

const concurrencySchema = (max: number) => z.number().int().min(1).max(max);
const gigabytesSchema = z.number().positive();

/** Editable instance parameters (`InstanceSettings`). */
export const instanceSettingsFieldsSchema = z
  .object({
    concurrencyPipeline: concurrencySchema(CONCURRENCY_PIPELINE_MAX),
    maxDataGB: gigabytesSchema,
    lowWaterFreeGB: gigabytesSchema,
    lowWaterFreeRatio: z.number().min(0).max(1),
    uploadRetentionDefault: z.enum(UPLOAD_RETENTION_POLICIES),
  })
  .strict();
export type InstanceSettingsFields = z.infer<typeof instanceSettingsFieldsSchema>;

export const INSTANCE_SETTING_KEYS = instanceSettingsFieldsSchema.keyof().options;

/**
 * The highest value each concurrency setting accepts. The number of
 * Tasks processed at once is the only one: model requests and local heavy work have no
 * setting of their own, the system paces them from it and from provider feedback.
 */
export const CONCURRENCY_LIMITS = {
  concurrencyPipeline: CONCURRENCY_PIPELINE_MAX,
} as const;
export type ConcurrencyKey = keyof typeof CONCURRENCY_LIMITS;
export type InstanceSettingKey = (typeof INSTANCE_SETTING_KEYS)[number];

/**
 * `GET /api/instance-settings`: effective values. Keys in `envOverridden` come from
 * environment variables and are read-only.
 */
export const instanceSettingsDtoSchema = instanceSettingsFieldsSchema.extend({
  updatedAt: z.number().int().nonnegative(),
  envOverridden: z.array(z.enum(INSTANCE_SETTING_KEYS)),
});
export type InstanceSettingsDto = z.infer<typeof instanceSettingsDtoSchema>;

/** `PATCH /api/instance-settings`: any non-empty subset of the editable fields. */
export const instanceSettingsPatchSchema = instanceSettingsFieldsSchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, { message: "at least one field is required" });
export type InstanceSettingsPatch = z.infer<typeof instanceSettingsPatchSchema>;
