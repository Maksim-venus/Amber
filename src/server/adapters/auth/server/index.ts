// AuthAdapter for server mode: opaque session cookies checked against the database.
import { SESSION_SLIDING_DAYS, SESSION_TOUCH_INTERVAL_MIN } from "../../../../shared/defaults.ts";
import type { Session } from "../../../domain/runtime-support.ts";
import { hashSessionId } from "../../../domain/session.ts";
import type { RequestPrincipal } from "../../../domain/user.ts";
import type { AuthAdapter, Authentication, AuthRequest } from "../../../ports/auth-adapter.ts";
import type { Repository, RepositoryScope } from "../../../ports/repository.ts";
import { sessionIdOf } from "./cookie.ts";

export { Argon2PasswordHasher } from "./password.ts";
export { SetupToken } from "./setup-token.ts";

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const SESSION_LIFETIME_MS = SESSION_SLIDING_DAYS * MS_PER_DAY;
const TOUCH_INTERVAL_MS = SESSION_TOUCH_INTERVAL_MIN * MS_PER_MINUTE;

export interface ServerAuthAdapterOptions {
  repository: Repository;
  /** Sessions revoked by this process (application `SessionRevocations`). */
  revocations: { has(sessionIdHash: string): boolean };
  now?: () => number;
}

/**
 * Session-cookie authentication. A session is valid while it is
 * neither expired nor revoked and its user exists and is active; a suspended user's
 * sessions are revoked with the suspension, so they fail here as unauthenticated. Expiry
 * slides by `SESSION_SLIDING_DAYS`, written at most every `SESSION_TOUCH_INTERVAL_MIN`.
 */
export class ServerAuthAdapter implements AuthAdapter {
  private readonly options: ServerAuthAdapterOptions;
  private readonly now: () => number;

  constructor(options: ServerAuthAdapterOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  authenticate(request: AuthRequest): RequestPrincipal | null {
    return this.authenticateWithSession(request)?.principal ?? null;
  }

  authenticateWithSession(request: AuthRequest): Authentication | null {
    const sessionId = sessionIdOf(request);
    if (sessionId === undefined) {
      return null;
    }
    const sessionIdHash = hashSessionId(sessionId);
    if (this.options.revocations.has(sessionIdHash)) {
      return null;
    }
    const now = this.now();
    return this.options.repository.withTransaction((scope) => {
      const checked = this.check(scope, sessionIdHash, now);
      if (checked === null) {
        return null;
      }
      const { session, principal } = checked;
      if (now - session.lastSeenAt < TOUCH_INTERVAL_MS) {
        return { principal, session: { sessionIdHash } };
      }
      const renewedUntil = now + SESSION_LIFETIME_MS;
      scope.sessions.touch(sessionIdHash, now, renewedUntil);
      return { principal, session: { sessionIdHash, renewedUntil } };
    });
  }

  isRevoked(sessionIdHash: string): boolean {
    return this.options.revocations.has(sessionIdHash);
  }

  isSessionValid(sessionIdHash: string): boolean {
    if (this.options.revocations.has(sessionIdHash)) {
      return false;
    }
    const now = this.now();
    return this.options.repository.withTransaction((scope) => this.check(scope, sessionIdHash, now) !== null);
  }

  private check(scope: RepositoryScope, sessionIdHash: string, now: number): { session: Session; principal: RequestPrincipal } | null {
    const session = scope.sessions.get(sessionIdHash);
    if (session === undefined || session.revokedAt !== undefined || session.expiresAt <= now) {
      return null;
    }
    const user = scope.users.get(session.userId);
    if (user === undefined || user.status !== "active") {
      return null;
    }
    const principal: RequestPrincipal = {
      userId: user.id,
      mode: "server",
      role: user.role,
      mustChangePassword: scope.users.getCredential(user.id)?.mustChangePassword ?? false,
    };
    return { session, principal };
  }
}
