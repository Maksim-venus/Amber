import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import type { MediaAssetService } from "../../application/media-assets.ts";
import { amberError } from "../../domain/errors.ts";
import { principalOf } from "../auth.ts";
import { decideRange } from "../range.ts";
import { parseInput } from "../validation.ts";

const paramsSchema = z.object({ assetId: z.string().min(1).max(64) });

/**
 * `GET / HEAD /api/media/:assetId` [server]: the browser's `<video>` streams uploads and
 * caches with a session cookie and seeks with single byte ranges.
 */
export function registerMediaPlaybackRoutes(app: FastifyInstance, deps: { media: MediaAssetService }): void {
  const serve = async (request: FastifyRequest, reply: FastifyReply, withBody: boolean) => {
    const { assetId } = parseInput(paramsSchema, request.params, "params");
    const media = await deps.media.playable(principalOf(request), assetId);
    const decision = decideRange(request.headers.range, media.sizeBytes);
    reply.header("Accept-Ranges", "bytes");
    if (decision.kind === "unsatisfiable") {
      reply.header("Content-Range", `bytes */${media.sizeBytes}`);
      throw amberError("invalid_request", "range not satisfiable", { code: "invalid_request.range_not_satisfiable" });
    }
    reply.header("Content-Type", media.mimeType);
    const range = decision.kind === "partial" ? { start: decision.start, end: decision.end } : undefined;
    const length = range === undefined ? media.sizeBytes : range.end - range.start + 1;
    reply.code(range === undefined ? 200 : 206).header("Content-Length", String(length));
    if (range !== undefined) {
      reply.header("Content-Range", `bytes ${range.start}-${range.end}/${media.sizeBytes}`);
    }
    if (!withBody || length === 0) {
      return reply.send();
    }
    return reply.send(Readable.from(media.read(range)));
  };
  app.get("/api/media/:assetId", { exposeHeadRoute: false }, (request, reply) => serve(request, reply, true));
  app.head("/api/media/:assetId", (request, reply) => serve(request, reply, false));
}

/** `DELETE /api/media/:assetId` (both modes): 204, per-kind semantics in the service. */
export function registerMediaDeleteRoute(app: FastifyInstance, deps: { media: MediaAssetService }): void {
  app.delete("/api/media/:assetId", async (request, reply) => {
    const { assetId } = parseInput(paramsSchema, request.params, "params");
    await deps.media.delete(principalOf(request), assetId);
    return reply.code(204).send();
  });
}
