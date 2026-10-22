import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authMeDtoSchema } from "../../../shared/dto/system.ts";
import type { RunMode } from "../../../shared/enums.ts";
import type { AuthService } from "../../application/auth.ts";
import { amberError, isAmberError } from "../../domain/errors.ts";
import { normalizeUsername } from "../../domain/user.ts";
import { principalOf } from "../auth.ts";
import type { ClientIpResolver } from "../client-ip.ts";
import type { LoginRateLimiter } from "../login-rate-limit.ts";
import { clearSessionCookie, setSessionCookie } from "../session-cookie.ts";
import { parseInput, sendValidated } from "../validation.ts";

/** Bounds the work one request can ask of argon2; far above any real password. */
export const PASSWORD_INPUT_MAX_CHARS = 1024;
/** Bounds a rate-limit bucket key built from an unacceptable username. */
const USERNAME_INPUT_MAX_CHARS = 256;

const passwordSchema = z.string().min(1).max(PASSWORD_INPUT_MAX_CHARS);
const loginRequestSchema = z.object({ username: z.string().min(1).max(USERNAME_INPUT_MAX_CHARS), password: passwordSchema }).strict();
const changePasswordRequestSchema = z.object({ currentPassword: passwordSchema, newPassword: passwordSchema }).strict();

export interface ServerAuthRouteDeps {
  auth: AuthService;
  limiter: LoginRateLimiter;
  clientIp: ClientIpResolver;
}

/**
 * `POST /api/auth/login` [server], `POST /api/auth/logout` (both modes; local has no
 * session and answers 204) and `POST /api/auth/change-password` [server].
 */
export function registerAuthRoutes(app: FastifyInstance, deps: { mode: RunMode; server?: ServerAuthRouteDeps }): void {
  const server = deps.server;
  app.post("/api/auth/logout", async (request, reply) => {
    if (server !== undefined) {
      server.auth.logout(request.sessionIdHash ?? undefined);
      clearSessionCookie(reply);
    }
    return reply.code(204).send();
  });
  if (deps.mode !== "server" || server === undefined) {
    return;
  }

  app.post("/api/auth/login", async (request, reply) => {
    const body = parseInput(loginRequestSchema, request.body, "body");
    const keys = { username: rateLimitKey(body.username), ip: clientIpOf(request, server.clientIp) };
    const retryAfterMs = server.limiter.check(keys);
    if (retryAfterMs !== undefined) {
      void reply.header("retry-after", String(Math.ceil(retryAfterMs / 1000)));
      throw amberError("rate_limited", "login attempts throttled");
    }
    try {
      const { me, session } = await server.auth.login(body);
      server.limiter.recordSuccess(keys);
      setSessionCookie(reply, session.sessionId, session.expiresAt);
      return sendValidated(reply, 200, authMeDtoSchema, me);
    } catch (error) {
      if (isAmberError(error) && error.appError.code === "unauthenticated.bad_credentials") {
        server.limiter.recordFailure(keys);
      }
      throw error;
    }
  });

  app.post("/api/auth/change-password", async (request, reply) => {
    const body = parseInput(changePasswordRequestSchema, request.body, "body");
    const me = await server.auth.changePassword(principalOf(request), request.sessionIdHash ?? undefined, body);
    return sendValidated(reply, 200, authMeDtoSchema, me);
  });
}

function rateLimitKey(username: string): string {
  return normalizeUsername(username) ?? username.trim().toLowerCase();
}

function clientIpOf(request: FastifyRequest, resolver: ClientIpResolver): string {
  return resolver.resolve(request.socket.remoteAddress, request.headers["x-forwarded-for"]);
}
