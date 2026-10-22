import { PASSWORD_MIN_LEN } from "../../shared/defaults.ts";
import type { RunMode, UserRole, UserStatus } from "../../shared/enums.ts";

export interface User {
  id: string;
  role: UserRole;
  status: UserStatus;
  displayName?: string;
  /** Absent means the user draws from the global storage pool. */
  storageLimitGB?: number;
  createdAt: number;
}

/** Exists only in server mode; local mode has no login credentials at all. */
export interface UserCredential {
  userId: string;
  username: string;
  /** argon2id hash; the plaintext password is never stored. */
  passwordHash: string;
  /** Set after an administrator reset so the next login forces a password change. */
  mustChangePassword: boolean;
}

/** Implicit single user of local mode: role admin, no UserCredential. */
export const LOCAL_USER_ID = "local";

/**
 * Produced by the AuthAdapter. Application services see only this, never cookies or
 * tokens. Invariant: they scope every owned resource by `userId`.
 */
export interface RequestPrincipal {
  userId: string;
  mode: RunMode;
  role: UserRole;
  /** Server mode after an admin reset; the API then admits only the password-change routes. Always false locally. */
  mustChangePassword: boolean;
}

/** A normalized username: 3–32 characters of `[a-z0-9._-]`. */
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/u;

/**
 * Login names are compared and stored normalized: trim, NFKC, then ASCII lowercase.
 * `undefined` means the name is not acceptable.
 */
export function normalizeUsername(raw: string): string | undefined {
  const normalized = raw.trim().normalize("NFKC").replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
  return USERNAME_PATTERN.test(normalized) ? normalized : undefined;
}

/** Only a minimum length; no character classes are required. Counted in code points. */
export function isAcceptablePassword(password: string): boolean {
  return [...password].length >= PASSWORD_MIN_LEN;
}
