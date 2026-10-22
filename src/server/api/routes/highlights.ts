import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { highlightsDtoSchema } from "../../../shared/dto/highlight.ts";
import { taskAcceptedDtoSchema } from "../../../shared/dto/task.ts";
import { derivedTaskRequestSchema } from "../../../shared/dto/transcript.ts";
import type { DerivedTaskService } from "../../application/derived-tasks.ts";
import type { HighlightService } from "../../application/highlights.ts";
import { principalOf } from "../auth.ts";
import { idempotencyKeyOf, parseInput, sendValidated } from "../validation.ts";

const idParamsSchema = z.object({ id: z.string().min(1) });

export interface HighlightRouteDeps {
  highlights?: HighlightService;
  derivedTasks?: DerivedTaskService;
}

/** `/api/contents/:id/highlights*`. */
export function registerHighlightRoutes(app: FastifyInstance, deps: HighlightRouteDeps): void {
  const { highlights, derivedTasks } = deps;
  if (highlights !== undefined) {
    app.get("/api/contents/:id/highlights", async (request, reply) => {
      const { id } = parseInput(idParamsSchema, request.params, "params");
      return sendValidated(reply, 200, highlightsDtoSchema, highlights.get(principalOf(request), id));
    });
  }

  if (derivedTasks !== undefined) {
    app.post("/api/contents/:id/highlights/recompute", async (request, reply) => {
      const { id } = parseInput(idParamsSchema, request.params, "params");
      const body = parseInput(derivedTaskRequestSchema, request.body ?? {}, "body");
      const result = await derivedTasks.recomputeHighlights(principalOf(request), id, body, idempotencyKeyOf(request));
      return sendValidated(reply, result.status, taskAcceptedDtoSchema, result.body);
    });
  }
}
