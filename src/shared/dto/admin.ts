import { z } from "zod";
import { USER_ROLES, USER_STATUSES } from "../enums.ts";

const bytesSchema = z.number().int().nonnegative();

/** One account as administrators see it; login credentials never appear. */
export const adminUserDtoSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  role: z.enum(USER_ROLES),
  status: z.enum(USER_STATUSES),
  displayName: z.string().exactOptional(),
  storageLimitGB: z.number().positive().exactOptional(),
  mustChangePassword: z.boolean(),
  createdAt: z.number().int().nonnegative(),
});
export type AdminUserDto = z.infer<typeof adminUserDtoSchema>;

export const adminUserListDtoSchema = z.object({ users: z.array(adminUserDtoSchema) });
export type AdminUserListDto = z.infer<typeof adminUserListDtoSchema>;

/** `GET /api/admin/storage`: the data volume and each user's `assets/<userId>/**` bytes. */
export const adminStorageDtoSchema = z.object({
  totalBytes: bytesSchema,
  freeBytes: bytesSchema,
  usedBytes: bytesSchema,
  users: z.array(
    z.object({
      userId: z.string().min(1),
      usedBytes: bytesSchema,
      storageLimitGB: z.number().positive().exactOptional(),
    }),
  ),
});
export type AdminStorageDto = z.infer<typeof adminStorageDtoSchema>;

/** `GET/PUT /api/admin/network-allowlist`: exact origins, normalized. */
export const networkAllowlistDtoSchema = z.object({ origins: z.array(z.string().min(1)) });
export type NetworkAllowlistDto = z.infer<typeof networkAllowlistDtoSchema>;

/** `POST /api/admin/credentials/reset`: the audit time written by the reset. */
export const credentialsResetDtoSchema = z.object({ credentialsResetAt: z.number().int().nonnegative() });
export type CredentialsResetDto = z.infer<typeof credentialsResetDtoSchema>;
