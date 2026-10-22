import type { FastifyInstance } from "fastify";
import { maintenanceDtoSchema, maintenanceRequestSchema, systemActivityDtoSchema } from "../../../shared/dto/backup.ts";
import { type AuthMeDto, authMeDtoSchema, versionDtoSchema } from "../../../shared/dto/system.ts";
import type { RunMode } from "../../../shared/enums.ts";
import type { RequestPrincipal } from "../../domain/user.ts";
import { principalOf } from "../auth.ts";
import type { Maintenance } from "../maintenance.ts";
import { parseInput, sendValidated } from "../validation.ts";

/**
 * `GET /api/health`, `GET /api/version` (non-sensitive status only) and `GET /api/auth/me`;
 * in local mode also the activity summary and the maintenance state entered before an
 * update install (`[client]`).
 */
export function registerSystemRoutes(
  app: FastifyInstance,
  deps: {
    version: string;
    mode: RunMode;
    /** Server mode adds the caller's login and display names; local mode has neither. */
    describe?: (principal: RequestPrincipal) => AuthMeDto;
    maintenance?: Maintenance;
  },
): void {
  app.get("/api/health", async () => ({ status: "ok" }));
  app.get("/api/version", async (_request, reply) => sendValidated(reply, 200, versionDtoSchema, { version: deps.version, mode: deps.mode }));
  app.get("/api/auth/me", async (request, reply) => {
    const principal = principalOf(request);
    if (deps.describe !== undefined) {
      return sendValidated(reply, 200, authMeDtoSchema, deps.describe(principal));
    }
    const { userId, role, mode, mustChangePassword } = principal;
    return sendValidated(reply, 200, authMeDtoSchema, { userId, role, mode, mustChangePassword });
  });

  const maintenance = deps.maintenance;
  if (maintenance === undefined) {
    return;
  }
  app.get("/api/system/activity", async (_request, reply) => sendValidated(reply, 200, systemActivityDtoSchema, maintenance.activity()));
  app.post("/api/system/maintenance", async (request, reply) => {
    parseInput(maintenanceRequestSchema, request.body, "body");
    return sendValidated(reply, 200, maintenanceDtoSchema, maintenance.arm());
  });
  app.delete("/api/system/maintenance", async (_request, reply) => {
    maintenance.disarm();
    return reply.code(204).send();
  });
}
