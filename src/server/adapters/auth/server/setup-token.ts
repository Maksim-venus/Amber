import { randomBytes, timingSafeEqual } from "node:crypto";
import { SETUP_TOKEN_TTL_MIN } from "../../../../shared/defaults.ts";
import type { SetupTokenGate } from "../../../ports/auth-adapter.ts";

const TOKEN_BYTES = 32;
const MS_PER_MINUTE = 60_000;

/**
 * The one-time bootstrap secret of the first-administrator wizard: 32 random bytes in
 * base64url, valid for `SETUP_TOKEN_TTL_MIN`, held only in this process. A failed attempt
 * does not consume it; once used or expired it is gone and a new one needs a restart.
 * `value` is read once by the start-up code to print it.
 */
export class SetupToken implements SetupTokenGate {
  readonly value: string;
  readonly expiresAt: number;
  private readonly bytes: Buffer;
  private consumed = false;
  private readonly now: () => number;

  constructor(options: { now?: () => number; value?: string } = {}) {
    this.now = options.now ?? Date.now;
    this.value = options.value ?? randomBytes(TOKEN_BYTES).toString("base64url");
    this.bytes = Buffer.from(this.value, "utf8");
    this.expiresAt = this.now() + SETUP_TOKEN_TTL_MIN * MS_PER_MINUTE;
  }

  matches(presented: string | undefined): boolean {
    if (this.consumed || presented === undefined || this.now() >= this.expiresAt) {
      return false;
    }
    const candidate = Buffer.from(presented, "utf8");
    return candidate.length === this.bytes.length && timingSafeEqual(candidate, this.bytes);
  }

  consume(): void {
    this.consumed = true;
  }
}
