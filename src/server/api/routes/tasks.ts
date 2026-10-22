import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_PAGE_SIZE_DEFAULT, API_PAGE_SIZE_MAX } from "../../../shared/defaults.ts";
import { TASK_KINDS } from "../../../shared/enums.ts";
import {
  retryStageRequestSchema,
  taskAcceptedDtoSchema,
  taskDetailDtoSchema,
  taskListDtoSchema,
} from "../../../shared/dto/task.ts";
import type { TaskService } from "../../application/tasks.ts";
import type { TaskEventBus } from "../../pipeline/events.ts";
import { principalOf } from "../auth.ts";
import { streamTaskEvents } from "../sse.ts";
import { idempotencyKeyOf, parseInput, sendValidated } from "../validation.ts";

const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_PAGE_SIZE_MAX).default(API_PAGE_SIZE_DEFAULT),
    cursor: z.string().min(1).exactOptional(),
    // `unfinished=1` asks for Tasks that have not reached a terminal state.
    unfinished: z.enum(["0", "1"]).transform((value) => value === "1").exactOptional(),
    // `finished=1` asks for Tasks that have reached one; it excludes `unfinished=1`.
    finished: z.enum(["0", "1"]).transform((value) => value === "1").exactOptional(),
    contentId: z.string().min(1).exactOptional(),
    collectionId: z.string().min(1).exactOptional(),
    kind: z.enum(TASK_KINDS).exactOptional(),
  })
  .strict()
  .refine((query) => !(query.finished === true && query.unfinished === true), {
    message: "finished and unfinished exclude each other",
    path: ["finished"],
  });
const taskParamsSchema = z.object({ id: z.string().min(1) });
const workUnitParamsSchema = z.object({ id: z.string().min(1), wid: z.string().min(1) });

/** `/api/tasks*`. */
export function registerTaskRoutes(app: FastifyInstance, deps: { tasks: TaskService; bus: TaskEventBus }): void {
  const { tasks, bus } = deps;

  app.get("/api/tasks", async (request, reply) => {
    const query = parseInput(listQuerySchema, request.query, "query");
    return sendValidated(reply, 200, taskListDtoSchema, tasks.list(principalOf(request), query));
  });

  app.get("/api/tasks/events", (request, reply) => {
    streamTaskEvents(request, reply, bus);
  });

  app.get("/api/tasks/:id", async (request, reply) => {
    const { id } = parseInput(taskParamsSchema, request.params, "params");
    return sendValidated(reply, 200, taskDetailDtoSchema, tasks.get(principalOf(request), id));
  });

  app.post("/api/tasks/:id/cancel", async (request, reply) => {
    const { id } = parseInput(taskParamsSchema, request.params, "params");
    return sendValidated(reply, 200, taskDetailDtoSchema, tasks.cancel(principalOf(request), id));
  });

  app.post("/api/tasks/:id/retry-stage", async (request, reply) => {
    const { id } = parseInput(taskParamsSchema, request.params, "params");
    const body = parseInput(retryStageRequestSchema, request.body, "body");
    const key = idempotencyKeyOf(request);
    return sendValidated(reply, 202, taskAcceptedDtoSchema, tasks.retryStage(principalOf(request), id, body, key));
  });

  app.post("/api/tasks/:id/work-units/:wid/confirm-resend", async (request, reply) => {
    const { id, wid } = parseInput(workUnitParamsSchema, request.params, "params");
    const key = idempotencyKeyOf(request);
    return sendValidated(reply, 202, taskAcceptedDtoSchema, tasks.confirmResend(principalOf(request), id, wid, key));
  });
}
