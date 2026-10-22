// AuthAdapter for local mode: per-launch sidecar token and the implicit local user.
import { timingSafeEqual } from "node:crypto";
import { LOCAL_USER_ID, type RequestPrincipal } from "../../../domain/user.ts";
import type { AuthAdapter, AuthRequest } from "../../../ports/auth-adapter.ts";

const BEARER = "Bearer ";

/**
 * Accepts exactly `Authorization: Bearer <sidecar token>`. The comparison is
 * constant-time; the token is only held in memory and never logged.
 */
export class LocalAuthAdapter implements AuthAdapter {
  private readonly expected: Buffer;

  constructor(token: string) {
    this.expected = Buffer.from(token);
  }

  authenticate(request: AuthRequest): RequestPrincipal | null {
    const header = request.headers["authorization"];
    if (typeof header !== "string" || !header.startsWith(BEARER)) {
      return null;
    }
    const presented = Buffer.from(header.slice(BEARER.length));
    if (presented.length !== this.expected.length || !timingSafeEqual(presented, this.expected)) {
      return null;
    }
    return { userId: LOCAL_USER_ID, mode: "local", role: "admin", mustChangePassword: false };
  }
}
