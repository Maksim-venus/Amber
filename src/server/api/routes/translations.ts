import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { taskAcceptedDtoSchema } from "../../../shared/dto/task.ts";
import { translationRequestSchema, translationsDtoSchema } from "../../../shared/dto/translation.ts";
import type { DerivedTaskService } from "../../application/derived-tasks.ts";
import type { TranslationService } from "../../application/translations.ts";
import { principalOf } from "../auth.ts";
import { idempotencyKeyOf, parseInput, sendValidated } from "../validation.ts";

const idParamsSchema = z.object({ id: z.string().min(1) });

export interface TranslationRouteDeps {
  translations?: TranslationService;
  derivedTasks?: DerivedTaskService;
}

/** `/api/contents/:id/translations`. */
export function registerTranslationRoutes(app: FastifyInstance, deps: TranslationRouteDeps): void {
  const { translations, derivedTasks } = deps;
  if (translations !== undefined) {
    app.get("/api/contents/:id/translations", async (request, reply) => {
      const { id } = parseInput(idParamsSchema, request.params, "params");
      return sendValidated(reply, 200, translationsDtoSchema, translations.get(principalOf(request), id));
    });
  }

  if (derivedTasks !== undefined) {
    app.post("/api/contents/:id/translations", async (request, reply) => {
      const { id } = parseInput(idParamsSchema, request.params, "params");
      const body = parseInput(translationRequestSchema, request.body ?? {}, "body");
      const result = await derivedTasks.translate(principalOf(request), id, body, idempotencyKeyOf(request));
      return sendValidated(reply, result.status, taskAcceptedDtoSchema, result.body);
    });
  }
}
