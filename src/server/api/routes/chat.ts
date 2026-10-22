import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { chatDtoSchema, chatMessageRequestSchema, chatQuerySchema, chatReplayDtoSchema, chatStreamEventSchemas } from "../../../shared/dto/chat.ts";
import type { ChatService } from "../../application/chat.ts";
import { principalOf } from "../auth.ts";
import { idempotencyKeyOf, parseInput, sendValidated } from "../validation.ts";

const idParamsSchema = z.object({ id: z.string().min(1) });

/**
 * `/api/contents/:id/chat*`. A new answer streams as SSE on the
 * POST response itself; every refusal is a plain JSON error raised before the stream
 * starts. The client going away aborts the upstream call and leaves the answer
 * `interrupted`; a replayed `Idempotency-Key` gets the stored answer as JSON.
 */
export function registerChatRoutes(app: FastifyInstance, deps: { chat: ChatService }): void {
  const { chat } = deps;

  app.get("/api/contents/:id/chat", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    const query = parseInput(chatQuerySchema, request.query, "query");
    return sendValidated(reply, 200, chatDtoSchema, chat.get(principalOf(request), id, query));
  });

  app.post("/api/contents/:id/chat/messages", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    const body = parseInput(chatMessageRequestSchema, request.body, "body");
    const key = idempotencyKeyOf(request);
    const controller = new AbortController();
    const result = chat.send(principalOf(request), id, body, key, controller.signal);
    if (result.kind === "replay") {
      return sendValidated(reply, 200, chatReplayDtoSchema, { message: result.message });
    }

    reply.hijack();
    const raw = reply.raw;
    // The response, not the request, closes when the client goes away (see api/sse.ts).
    raw.once("close", () => controller.abort());
    raw.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    // Drained to the end even after the client left, so the answer's final state is stored.
    // A session revoked meanwhile ends the stream, which aborts the answer.
    const guard = request.sessionGuard;
    for await (const event of result.events) {
      const data = chatStreamEventSchemas[event.type].parse(event.data);
      if (guard?.revoked() === true && !raw.destroyed) {
        raw.destroy();
      }
      if (!raw.destroyed && !raw.writableEnded) {
        raw.write(`event: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    }
    if (!raw.destroyed && !raw.writableEnded) {
      raw.end();
    }
  });

  app.delete("/api/contents/:id/chat", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    chat.clear(principalOf(request), id);
    return reply.code(204).send();
  });
}
