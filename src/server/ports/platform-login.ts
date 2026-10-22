import type { Platform } from "../domain/platform.ts";

/** What the platform says about a QR code; `confirmed` carries the login it handed over. */
export type QrPollResult =
  | { status: "pending" | "scanned" | "expired" }
  | {
      status: "confirmed";
      /** The login as canonical Netscape cookies.txt, filtered to the platform's domains. */
      cookies: string;
    };

export interface QrLoginTicket {
  /** The content of the QR code shown to the user. */
  qrUrl: string;
  /** Adapter-private handle for polling; a short-lived login token, never logged. */
  key: string;
  /** Unix ms when the platform says the code lapses, if it says so. */
  expiresAt?: number;
}

/**
 * Obtaining a platform login by QR code. Kept apart from
 * `PlatformSourceAdapter`, which never learns how a login was obtained. Errors use the
 * source error classes (`source_unreachable`, `platform_blocked`).
 */
export interface PlatformQrLogin {
  readonly platform: Platform;
  start(signal: AbortSignal): Promise<QrLoginTicket>;
  poll(key: string, signal: AbortSignal): Promise<QrPollResult>;
}
