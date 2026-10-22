import type { FastifyReply, FastifyRequest } from "fastify";
import { SSE_HEARTBEAT_MS } from "../../shared/defaults.ts";
import type { TaskEventBus } from "../pipeline/events.ts";
import { principalOf } from "./auth.ts";

/**
 * `GET /api/tasks/events`: live task events of the requesting user only,
 * framed as `event` / `data` / `id` with the bus sequence as id. The stream is pure
 * observation: closing it affects no Task. A comment line every `SSE_HEARTBEAT_MS` keeps
 * idle connections alive through proxies. No replay: clients merge with a snapshot's
 * `eventSeq` after subscribing. In server mode a revoked session closes the stream before
 * the next push (in-process revocation set) and on the next heartbeat (database re-check:
 * revoked, expired or user suspended).
 */
export function streamTaskEvents(request: FastifyRequest, reply: FastifyReply, bus: TaskEventBus): void {
  const { userId } = principalOf(request);
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    ...(reply.getHeaders() as Record<string, string>),
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  raw.write(": connected\n\n");

  const guard = request.sessionGuard;
  const unsubscribe = bus.subscribe((published) => {
    if (published.userId !== userId || raw.destroyed) {
      return;
    }
    if (guard?.revoked() === true) {
      end();
      return;
    }
    raw.write(`event: ${published.event.type}\ndata: ${JSON.stringify(published.event)}\nid: ${published.seq}\n\n`);
  });
  const heartbeat = setInterval(() => {
    if (raw.destroyed) {
      return;
    }
    if (guard !== null && !guard.valid()) {
      end();
      return;
    }
    raw.write(": heartbeat\n\n");
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref();

  let closed = false;
  const end = (): void => {
    close();
    if (!raw.writableEnded) {
      raw.end();
    }
  };
  const close = (): void => {
    if (!closed) {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    }
  };
  // The response, not the request, closes when the client goes away: a request stream
  // may report `close` as soon as its (empty) body has been read.
  raw.once("close", close);
  raw.once("error", close);
}
