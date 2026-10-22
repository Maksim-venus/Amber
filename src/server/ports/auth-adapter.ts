import type { RequestPrincipal } from "../domain/user.ts";

/** The request surface an AuthAdapter may inspect; no framework types cross this port. */
export interface AuthRequest {
  headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** The server-mode session behind an authenticated request. */
export interface AuthSession {
  sessionIdHash: string;
  /** Set when this request slid the session's expiry: the cookie is re-issued to last until then. */
  renewedUntil?: number;
}

export interface Authentication {
  principal: RequestPrincipal;
  /** Absent in local mode, which has no sessions. */
  session?: AuthSession;
}

/**
 * Turns request credentials into a `RequestPrincipal`. Local mode
 * checks the per-launch sidecar token; server mode checks the session cookie. `null`
 * means unauthenticated. Services only ever see the principal.
 */
export interface AuthAdapter {
  authenticate(request: AuthRequest): RequestPrincipal | null;
  /** Like `authenticate`, also naming the session; adapters without sessions need not implement it. */
  authenticateWithSession?(request: AuthRequest): Authentication | null;
  /**
   * Whether a session was revoked by this process; cheap, checked before every push on an
   * open event stream.
   */
  isRevoked?(sessionIdHash: string): boolean;
  /** Re-checks a session against the database: live, not revoked, its user active. */
  isSessionValid?(sessionIdHash: string): boolean;
}

/** The first-administrator setup token as the wizard sees it. */
export interface SetupTokenGate {
  /** Constant-time; false once consumed or expired. A failed comparison consumes nothing. */
  matches(presented: string | undefined): boolean;
  consume(): void;
}
