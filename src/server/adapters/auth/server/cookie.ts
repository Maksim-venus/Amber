import { SESSION_COOKIE } from "../../../domain/session.ts";
import type { AuthRequest } from "../../../ports/auth-adapter.ts";

/**
 * The session id the request's cookie carries, if any. Session ids are base64url, so the
 * value needs no decoding; a cookie of that name sent twice is treated as absent.
 */
export function sessionIdOf(request: AuthRequest): string | undefined {
  const header = request.headers["cookie"];
  if (typeof header !== "string") {
    return undefined;
  }
  const values = header
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.startsWith(`${SESSION_COOKIE}=`))
    .map((pair) => pair.slice(SESSION_COOKIE.length + 1));
  return values.length === 1 && values[0] !== "" ? values[0] : undefined;
}
