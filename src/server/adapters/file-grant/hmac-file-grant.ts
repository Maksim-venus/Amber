import { createHmac, timingSafeEqual } from "node:crypto";
import { FILE_GRANT_TTL_MS } from "../../../shared/defaults.ts";
import type { FileGrant, FileGrantPurpose } from "../../../shared/dto/local-media.ts";
import type { FileGrantIssuer, FileGrantVerifier, IssuedFileGrantPurpose } from "../../ports/file-grant.ts";

export const FILE_GRANT_KEY_ENV = "AMBER_FILE_GRANT_KEY";
const KEY_BYTES = 32;

/** The shell passes 32 random bytes as base64url; anything else is a configuration error. */
export function parseFileGrantKey(value: string | undefined): Buffer {
  const key = value === undefined || !/^[A-Za-z0-9_-]+$/.test(value) ? undefined : Buffer.from(value, "base64url");
  if (key?.length !== KEY_BYTES) {
    throw new Error(`${FILE_GRANT_KEY_ENV} must be ${KEY_BYTES} bytes encoded as base64url`);
  }
  return key;
}

function signatureOf(key: Buffer, grant: Omit<FileGrant, "sig">): Buffer {
  return createHmac("sha256", key).update(`${grant.purpose}|${grant.path}|${grant.expiresAt}`, "utf8").digest();
}

/**
 * Signs a grant the way the desktop shell does. Production grants come only from the
 * shell's file dialog commands; this exists for tests and the development runner.
 */
export function signFileGrant(key: Buffer, grant: Omit<FileGrant, "sig">): FileGrant {
  return { ...grant, sig: signatureOf(key, grant).toString("base64url") };
}

/** Verifies the shell's grants and issues the sidecar's own `burn_output` / `cache_save` grants under the same key. */
export class HmacFileGrantVerifier implements FileGrantVerifier, FileGrantIssuer {
  private readonly key: Buffer;
  private readonly now: () => number;

  constructor(key: Buffer, now: () => number = Date.now) {
    this.key = key;
    this.now = now;
  }

  verify(grant: FileGrant, expected: { path: string; purpose: FileGrantPurpose }): boolean {
    const now = this.now();
    // A grant living longer than the shell ever issues is forged or from a skewed signer.
    if (grant.path !== expected.path || grant.purpose !== expected.purpose || grant.expiresAt <= now || grant.expiresAt - now > FILE_GRANT_TTL_MS) {
      return false;
    }
    const actual = Buffer.from(grant.sig, "base64url");
    const wanted = signatureOf(this.key, grant);
    return actual.length === wanted.length && timingSafeEqual(actual, wanted);
  }

  issue(grant: { path: string; purpose: IssuedFileGrantPurpose }): FileGrant {
    return signFileGrant(this.key, { ...grant, expiresAt: this.now() + FILE_GRANT_TTL_MS });
  }
}
