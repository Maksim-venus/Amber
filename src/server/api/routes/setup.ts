import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DISPLAY_NAME_MAX_CHARS } from "../../../shared/defaults.ts";
import { authMeDtoSchema, setupStatusDtoSchema } from "../../../shared/dto/system.ts";
import type { AuthService } from "../../application/auth.ts";
import { amberError } from "../../domain/errors.ts";
import { parseInput, sendValidated } from "../validation.ts";
import { setSessionCookie } from "../session-cookie.ts";
import { PASSWORD_INPUT_MAX_CHARS } from "./auth.ts";

const setupRequestSchema = z
  .object({
    username: z.string().min(1).max(256),
    password: z.string().min(1).max(PASSWORD_INPUT_MAX_CHARS),
    displayName: z.string().trim().min(1).max(DISPLAY_NAME_MAX_CHARS).optional(),
  })
  .strict();

/**
 * `GET/POST /api/setup` [server]: creates the first administrator once, checks in the order
 * noted in the handler. The one-time token arrives only in the `X-Amber-Setup-Token`
 * header, never in the URL.
 */
export function registerSetupRoutes(app: FastifyInstance, deps: { auth: AuthService }): void {
  app.get("/api/setup", async (request, reply) =>
    sendValidated(reply, 200, setupStatusDtoSchema, deps.auth.setupStatus(setupTokenOf(request))),
  );

  app.post("/api/setup", async (request, reply) => {
    const token = setupTokenOf(request);
    // An initialized instance answers `conflict` whatever the body; otherwise the token is
    // checked before the body so a caller without it learns nothing else.
    if (deps.auth.setupStatus(token).initialized) {
      throw amberError("conflict", "instance already initialized");
    }
    const body = parseInput(setupRequestSchema, request.body, "body");
    const { me, session } = await deps.auth.setup(token, {
      username: body.username,
      password: body.password,
      ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
    });
    setSessionCookie(reply, session.sessionId, session.expiresAt);
    return sendValidated(reply, 201, authMeDtoSchema, me);
  });
}

function setupTokenOf(request: FastifyRequest): string | undefined {
  const header = request.headers["x-amber-setup-token"];
  return typeof header === "string" ? header : undefined;
}
