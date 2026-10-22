import type { FastifyInstance } from "fastify";
import { storageDtoSchema } from "../../../shared/dto/storage.ts";
import type { StorageQuota } from "../../application/storage-quota.ts";
import { principalOf } from "../auth.ts";
import { sendValidated } from "../validation.ts";

/** `GET /api/storage` (server mode): the caller's own usage and limit. */
export function registerStorageRoutes(app: FastifyInstance, deps: { quota: StorageQuota }): void {
  app.get("/api/storage", async (request, reply) => sendValidated(reply, 200, storageDtoSchema, await deps.quota.usage(principalOf(request))));
}
