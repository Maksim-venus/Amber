import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { chaptersCurrentRequestSchema, chaptersDtoSchema } from "../../../shared/dto/chapter.ts";
import { taskAcceptedDtoSchema } from "../../../shared/dto/task.ts";
import { derivedTaskRequestSchema } from "../../../shared/dto/transcript.ts";
import type { ChapterService } from "../../application/chapters.ts";
import type { DerivedTaskService } from "../../application/derived-tasks.ts";
import { principalOf } from "../auth.ts";
import { idempotencyKeyOf, parseInput, sendValidated } from "../validation.ts";

const idParamsSchema = z.object({ id: z.string().min(1) });

export interface ChapterRouteDeps {
  chapters?: ChapterService;
  derivedTasks?: DerivedTaskService;
}

/** `/api/contents/:id/chapters*`. */
export function registerChapterRoutes(app: FastifyInstance, deps: ChapterRouteDeps): void {
  const { chapters, derivedTasks } = deps;
  if (chapters !== undefined) {
    app.get("/api/contents/:id/chapters", async (request, reply) => {
      const { id } = parseInput(idParamsSchema, request.params, "params");
      return sendValidated(reply, 200, chaptersDtoSchema, chapters.get(principalOf(request), id));
    });

    app.put("/api/contents/:id/chapters/current", async (request, reply) => {
      const { id } = parseInput(idParamsSchema, request.params, "params");
      const { revisionId } = parseInput(chaptersCurrentRequestSchema, request.body, "body");
      return sendValidated(reply, 200, chaptersDtoSchema, chapters.setCurrent(principalOf(request), id, revisionId));
    });
  }

  if (derivedTasks !== undefined) {
    app.post("/api/contents/:id/chapters/regenerate", async (request, reply) => {
      const { id } = parseInput(idParamsSchema, request.params, "params");
      const body = parseInput(derivedTaskRequestSchema, request.body ?? {}, "body");
      const result = await derivedTasks.regenerateChapters(principalOf(request), id, body, idempotencyKeyOf(request));
      return sendValidated(reply, result.status, taskAcceptedDtoSchema, result.body);
    });
  }
}
