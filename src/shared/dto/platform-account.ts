import { z } from "zod";
import { COOKIE_BROWSERS } from "./settings.ts";
import { CREDENTIAL_STATUSES, PLATFORM_ACCOUNT_STATUSES, PLATFORM_QR_STATUSES, PLATFORMS } from "../enums.ts";

/**
 * One row per supported platform, whether or not an account exists.
 * The cookie never appears in a DTO; `hasCredential` is derived from `credentialStatus`.
 */
export const platformAccountDtoSchema = z.object({
  platform: z.enum(PLATFORMS),
  credentialStatus: z.enum(CREDENTIAL_STATUSES),
  hasCredential: z.boolean(),
  status: z.enum(PLATFORM_ACCOUNT_STATUSES).exactOptional(),
  checkedAt: z.number().int().nonnegative().exactOptional(),
});
export type PlatformAccountDto = z.infer<typeof platformAccountDtoSchema>;

export const platformAccountListDtoSchema = z.object({ accounts: z.array(platformAccountDtoSchema) });
export type PlatformAccountListDto = z.infer<typeof platformAccountListDtoSchema>;

export const platformCheckDtoSchema = z.object({ status: z.enum(PLATFORM_ACCOUNT_STATUSES) });
export type PlatformCheckDto = z.infer<typeof platformCheckDtoSchema>;

/**
 * A QR login attempt (server mode). `qrUrl` is what the code encodes; it is a short-lived
 * login token, so it is shown to its owner only and never logged.
 */
export const platformQrAttemptDtoSchema = z.object({
  attemptId: z.string().min(1),
  qrUrl: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
});
export type PlatformQrAttemptDto = z.infer<typeof platformQrAttemptDtoSchema>;

export const platformQrStatusDtoSchema = z.object({ status: z.enum(PLATFORM_QR_STATUSES) });
export type PlatformQrStatusDto = z.infer<typeof platformQrStatusDtoSchema>;

/**
 * `POST /api/platform-accounts/youtube/import-browser` [client]: the browser whose login is
 * read; without one, the user's `platformCookieBrowser`, else `PLATFORM_COOKIE_BROWSER_DEFAULT`.
 */
export const importBrowserRequestSchema = z.object({ browser: z.enum(COOKIE_BROWSERS).exactOptional() }).strict();
export type ImportBrowserRequest = z.infer<typeof importBrowserRequestSchema>;
