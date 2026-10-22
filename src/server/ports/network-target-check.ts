/**
 * Save-time half of the outbound network policy: a user-entered endpoint
 * such as a provider `baseURL` is checked when it is stored as well as on every request.
 * Rejects with a `network_blocked_by_policy` AmberError; local mode accepts everything.
 */
export interface NetworkTargetCheck {
  check(url: string): Promise<void>;
}

/** Local mode: the only user is the machine's owner. */
export const PERMISSIVE_TARGET_CHECK: NetworkTargetCheck = { check: async () => undefined };
