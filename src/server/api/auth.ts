import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RunMode } from "../../shared/enums.ts";
import { appError } from "../domain/errors.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { AuthAdapter, Authentication } from "../ports/auth-adapter.ts";
import { checkCsrf } from "./csrf.ts";

/** Checks an open event stream makes against the session that opened it. */
export interface StreamSessionGuard {
  /** In-process revocation set only; before every push. */
  revoked(): boolean;
  /** Database re-check; on every heartbeat. */
  valid(): boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    principal: RequestPrincipal | null;
    /** Server mode: hash of the session behind the request. */
    sessionIdHash: string | null;
    /** Server mode: what an SSE stream re-checks while open. */
    sessionGuard: StreamSessionGuard | null;
  }
}

export interface AuthenticationOptions {
  mode: RunMode;
  /** Server mode: the canonical origin CSRF checks compare against (`AMBER_PUBLIC_ORIGIN`). */
  publicOrigin?: string;
  /** Server mode: re-issues the session cookie whose expiry just slid. */
  renewCookie?: (request: FastifyRequest, reply: FastifyReply, renewedUntil: number) => void;
}

/** Endpoints reachable without a session in server mode; local mode has none. */
const PUBLIC_ROUTES = new Set(["GET /api/health", "GET /api/version", "POST /api/auth/login", "GET /api/setup", "POST /api/setup"]);

/** What a principal under a forced password change may still call. */
const PASSWORD_CHANGE_ROUTES = new Set(["GET /api/auth/me", "POST /api/auth/logout", "POST /api/auth/change-password"]);

/**
 * Authenticates every `/api` request before routing, unmatched routes included, so an
 * unauthenticated caller learns nothing about which routes exist; paths outside `/api` are
 * static assets and the SPA fallback and need no credentials. In local mode every `/api`
 * route, health and version included, requires the sidecar token, and CORS preflights are
 * answered by the CORS plugin. In server mode unsafe methods first pass the CSRF rules
 * (`checkCsrf`), then the session cookie is checked, then a forced password change admits
 * only the routes needed to complete it.
 */
export function installAuthentication(app: FastifyInstance, auth: AuthAdapter, options: AuthenticationOptions = { mode: "local" }): void {
  app.decorateRequest("principal", null);
  app.decorateRequest("sessionIdHash", null);
  app.decorateRequest("sessionGuard", null);
  app.addHook("onRequest", async (request, reply) => {
    if (!isApiRequest(request)) {
      return;
    }
    if (options.mode === "local") {
      if (request.method === "OPTIONS") {
        return;
      }
      request.principal = auth.authenticate({ headers: request.headers });
      if (request.principal === null) {
        await reply.code(401).send({ error: appError("unauthenticated") });
      }
      return;
    }

    const route = `${request.method} ${request.routeOptions.url ?? ""}`;
    if (!SAFE_METHODS.has(request.method)) {
      const refusal = checkCsrf(request, options.publicOrigin ?? "");
      if (refusal !== undefined) {
        request.log.info({ reason: refusal }, "csrf_rejected");
        await reply.code(401).send({ error: appError("unauthenticated", { code: "unauthenticated.csrf" }) });
        return;
      }
    }
    if (request.routeOptions.url !== undefined && PUBLIC_ROUTES.has(route)) {
      return;
    }
    const authentication: Authentication | null =
      auth.authenticateWithSession?.({ headers: request.headers }) ?? principalOnly(auth.authenticate({ headers: request.headers }));
    if (authentication === null) {
      await reply.code(401).send({ error: appError("unauthenticated") });
      return;
    }
    request.principal = authentication.principal;
    const session = authentication.session;
    if (session !== undefined) {
      request.sessionIdHash = session.sessionIdHash;
      request.sessionGuard = {
        revoked: () => auth.isRevoked?.(session.sessionIdHash) ?? false,
        valid: () => auth.isSessionValid?.(session.sessionIdHash) ?? true,
      };
      if (session.renewedUntil !== undefined) {
        options.renewCookie?.(request, reply, session.renewedUntil);
      }
    }
    if (authentication.principal.mustChangePassword && !PASSWORD_CHANGE_ROUTES.has(route)) {
      await reply.code(403).send({ error: appError("forbidden", { code: "forbidden.must_change_password" }) });
    }
  });
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function principalOnly(principal: RequestPrincipal | null): Authentication | null {
  return principal === null ? null : { principal };
}

/**
 * Whether the request belongs to the API: its matched route is an `/api` route, or its
 * path (percent-decoded, so an encoded prefix cannot slip past) starts with `/api`. A
 * catch-all static route must not swallow an unknown `/api` path.
 */
function isApiRequest(request: FastifyRequest): boolean {
  const route = request.routeOptions.url;
  if (route !== undefined && isApiPath(route)) {
    return true;
  }
  const path = request.url.split("?")[0] ?? "";
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // A malformed escape is checked as written.
  }
  return isApiPath(path) || isApiPath(decoded);
}

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

/** The principal of an authenticated request; routes run only after the hook accepted it. */
export function principalOf(request: FastifyRequest): RequestPrincipal {
  if (request.principal === null) {
    throw new TypeError("route reached without an authenticated principal");
  }
  return request.principal;
}
