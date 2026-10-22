import type { FastifyReply, FastifyRequest } from "fastify";
import "@fastify/cookie";
import { SESSION_COOKIE } from "../domain/session.ts";

/** Session cookie attributes (`Secure; HttpOnly; SameSite=Lax; Path=/`, no `Domain`); the `__Host-` prefix makes the browser insist on them. */
const ATTRIBUTES = { secure: true, httpOnly: true, sameSite: "lax", path: "/" } as const;

/** Issues (or re-issues with a slid expiry) the session cookie. Needs the cookie plugin. */
export function setSessionCookie(reply: FastifyReply, sessionId: string, expiresAt: number): void {
  void reply.setCookie(SESSION_COOKIE, sessionId, { ...ATTRIBUTES, expires: new Date(expiresAt) });
}

/** An already-expired cookie, which makes the browser drop the session id. */
export function clearSessionCookie(reply: FastifyReply): void {
  void reply.clearCookie(SESSION_COOKIE, ATTRIBUTES);
}

/** The session id the request presents, if any. */
export function sessionIdOfRequest(request: FastifyRequest): string | undefined {
  const value = request.cookies[SESSION_COOKIE];
  return value === undefined || value === "" ? undefined : value;
}
