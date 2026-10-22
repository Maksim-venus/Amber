import { z } from "zod";
import { RUN_MODES, USER_ROLES } from "../enums.ts";

/** `GET /api/version`: non-sensitive status only. */
export const versionDtoSchema = z.object({ version: z.string().min(1), mode: z.enum(RUN_MODES) });
export type VersionDto = z.infer<typeof versionDtoSchema>;

/** `GET /api/auth/me`. `username` and `displayName` exist only in server mode. */
export const authMeDtoSchema = z.object({
  userId: z.string().min(1),
  username: z.string().min(1).exactOptional(),
  displayName: z.string().min(1).exactOptional(),
  role: z.enum(USER_ROLES),
  mode: z.enum(RUN_MODES),
  mustChangePassword: z.boolean(),
});
export type AuthMeDto = z.infer<typeof authMeDtoSchema>;

/**
 * `GET /api/setup`: whether the server instance has its first administrator. Before that,
 * only a valid setup token may ask.
 */
export const setupStatusDtoSchema = z.object({ initialized: z.boolean() });
export type SetupStatusDto = z.infer<typeof setupStatusDtoSchema>;
