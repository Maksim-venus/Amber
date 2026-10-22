import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  adminStorageDtoSchema,
  adminUserDtoSchema,
  adminUserListDtoSchema,
  credentialsResetDtoSchema,
  networkAllowlistDtoSchema,
} from "../../../shared/dto/admin.ts";
import { USER_ROLES, USER_STATUSES, type RunMode } from "../../../shared/enums.ts";
import { requireAdmin, type AdminService } from "../../application/admin.ts";
import type { RequestPrincipal } from "../../domain/user.ts";
import { principalOf } from "../auth.ts";
import { parseInput, sendValidated } from "../validation.ts";

const idParamsSchema = z.object({ id: z.string().min(1) });
const displayNameSchema = z.string().trim().min(1).max(64);
// Login secrets are request-only fields; their schemas stay on the server side.
const passwordSchema = z.string().min(1).max(1024);

const createUserSchema = z
  .object({
    username: z.string().min(1).max(256),
    password: passwordSchema,
    displayName: displayNameSchema.optional(),
    role: z.enum(USER_ROLES),
  })
  .strict();

const patchUserSchema = z
  .object({
    status: z.enum(USER_STATUSES).optional(),
    role: z.enum(USER_ROLES).optional(),
    displayName: displayNameSchema.nullable().optional(),
    storageLimitGB: z.number().positive().nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: "at least one field is required" });

const resetPasswordSchema = z.object({ newPassword: passwordSchema }).strict();
const allowlistSchema = z.object({ origins: z.array(z.string().max(2048)).max(1000) }).strict();

/**
 * `/api/admin/*`. Account, storage and allowlist administration exist
 * only in server mode; `POST /api/admin/credentials/reset` exists in both, because the
 * local user is the administrator. The role is checked before the body is parsed, and the
 * service checks it again on every call.
 */
export function registerAdminRoutes(app: FastifyInstance, deps: { admin: AdminService; mode: RunMode }): void {
  const { admin } = deps;
  const adminOf = (request: FastifyRequest): RequestPrincipal => {
    const principal = principalOf(request);
    requireAdmin(principal);
    return principal;
  };

  app.post("/api/admin/credentials/reset", async (request, reply) =>
    sendValidated(reply, 200, credentialsResetDtoSchema, await admin.resetCredentials(principalOf(request))),
  );

  if (deps.mode !== "server") {
    return;
  }

  app.get("/api/admin/users", async (request, reply) => sendValidated(reply, 200, adminUserListDtoSchema, admin.listUsers(principalOf(request))));

  app.post("/api/admin/users", async (request, reply) => {
    const principal = adminOf(request);
    const body = parseInput(createUserSchema, request.body, "body");
    return sendValidated(
      reply,
      201,
      adminUserDtoSchema,
      await admin.createUser(principal, {
        username: body.username,
        password: body.password,
        role: body.role,
        ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
      }),
    );
  });

  app.patch("/api/admin/users/:id", async (request, reply) => {
    const principal = adminOf(request);
    const { id } = parseInput(idParamsSchema, request.params, "params");
    const patch = parseInput(patchUserSchema, request.body, "body");
    return sendValidated(
      reply,
      200,
      adminUserDtoSchema,
      admin.patchUser(principal, id, {
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.role === undefined ? {} : { role: patch.role }),
        ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
        ...(patch.storageLimitGB === undefined ? {} : { storageLimitGB: patch.storageLimitGB }),
      }),
    );
  });

  app.post("/api/admin/users/:id/reset-password", async (request, reply) => {
    const principal = adminOf(request);
    const { id } = parseInput(idParamsSchema, request.params, "params");
    const body = parseInput(resetPasswordSchema, request.body, "body");
    await admin.resetPassword(principal, id, body);
    return reply.code(204).send();
  });

  app.delete("/api/admin/users/:id", async (request, reply) => {
    const principal = adminOf(request);
    const { id } = parseInput(idParamsSchema, request.params, "params");
    await admin.deleteUser(principal, id);
    return reply.code(204).send();
  });

  app.get("/api/admin/storage", async (request, reply) => sendValidated(reply, 200, adminStorageDtoSchema, await admin.storage(principalOf(request))));

  app.get("/api/admin/network-allowlist", async (request, reply) =>
    sendValidated(reply, 200, networkAllowlistDtoSchema, admin.getAllowlist(principalOf(request))),
  );

  app.put("/api/admin/network-allowlist", async (request, reply) => {
    const principal = adminOf(request);
    const body = parseInput(allowlistSchema, request.body, "body");
    return sendValidated(reply, 200, networkAllowlistDtoSchema, admin.putAllowlist(principal, body));
  });
}
