import { z } from "zod";

/**
 * `GET /api/storage`: the caller's own `assets/<userId>/**` bytes and
 * limit. No limit means the user draws from the shared pool that the disk watermark guards.
 */
export const storageDtoSchema = z.object({
  usedBytes: z.number().int().nonnegative(),
  storageLimitGB: z.number().positive().exactOptional(),
});
export type StorageDto = z.infer<typeof storageDtoSchema>;
