import { createHash, randomBytes } from "node:crypto";

/** Bytes of entropy in an opaque session id. */
const SESSION_ID_BYTES = 32;

/** A new high-entropy opaque session id for the cookie; only its hash is ever stored. */
export function newSessionId(): string {
  return randomBytes(SESSION_ID_BYTES).toString("base64url");
}

/** The stored form of a session id: SHA-256, hex. */
export function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId, "utf8").digest("hex");
}

/** `__Host-` binds the cookie to this exact origin: Secure, Path=/ and no Domain are mandatory. */
export const SESSION_COOKIE = "__Host-amber-session";
