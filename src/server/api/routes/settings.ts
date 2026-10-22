import type { FastifyInstance } from "fastify";
import { userSettingsDtoSchema, userSettingsPatchSchema } from "../../../shared/dto/settings.ts";
import type { SettingsService } from "../../application/settings.ts";
import { principalOf } from "../auth.ts";
import { parseInput, sendValidated } from "../validation.ts";

/** `GET / PATCH /api/settings`: the principal's own preferences. */
export function registerSettingsRoutes(app: FastifyInstance, deps: { settings: SettingsService }): void {
  app.get("/api/settings", async (request, reply) => sendValidated(reply, 200, userSettingsDtoSchema, deps.settings.get(principalOf(request))));

  app.patch("/api/settings", async (request, reply) => {
    const body = parseInput(userSettingsPatchSchema, request.body, "body");
    return sendValidated(reply, 200, userSettingsDtoSchema, deps.settings.patch(principalOf(request), body));
  });
}
