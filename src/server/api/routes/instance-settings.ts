import type { FastifyInstance } from "fastify";
import { instanceSettingsDtoSchema, instanceSettingsPatchSchema } from "../../../shared/dto/instance-settings.ts";
import type { InstanceSettingsService } from "../../application/instance-settings.ts";
import { principalOf } from "../auth.ts";
import { parseInput, sendValidated } from "../validation.ts";

/** `GET/PATCH /api/instance-settings` (admin only, environment-fixed keys read-only). */
export function registerInstanceSettingsRoutes(app: FastifyInstance, deps: { instanceSettings: InstanceSettingsService }): void {
  app.get("/api/instance-settings", async (request, reply) =>
    sendValidated(reply, 200, instanceSettingsDtoSchema, deps.instanceSettings.get(principalOf(request))),
  );

  app.patch("/api/instance-settings", async (request, reply) => {
    const patch = parseInput(instanceSettingsPatchSchema, request.body, "body");
    return sendValidated(reply, 200, instanceSettingsDtoSchema, deps.instanceSettings.patch(principalOf(request), patch));
  });
}
