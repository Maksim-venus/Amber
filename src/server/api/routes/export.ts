import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { collectionExportRequestSchema, contentExportRequestSchema } from "../../../shared/dto/export.ts";
import { exportDisposition, type ExportFile, type ExportService } from "../../application/export.ts";
import { principalOf } from "../auth.ts";
import { parseInput } from "../validation.ts";

const idParamsSchema = z.object({ id: z.string().min(1) });

export interface ExportRouteDeps {
  exports: ExportService;
}

/**
 * `POST /api/contents/:id/export` and `POST /api/collections/:id/export`. Exports are
 * synchronous: the response is the file itself, streamed as an attachment. Anything
 * refused is refused before the first byte, as a JSON error.
 */
export function registerExportRoutes(app: FastifyInstance, deps: ExportRouteDeps): void {
  const { exports } = deps;

  app.post("/api/contents/:id/export", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    const body = parseInput(contentExportRequestSchema, request.body ?? {}, "body");
    return sendFile(reply, exports.exportContent(principalOf(request), id, body));
  });

  app.post("/api/collections/:id/export", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    const body = parseInput(collectionExportRequestSchema, request.body ?? {}, "body");
    return sendFile(reply, exports.exportCollection(principalOf(request), id, body));
  });
}

function sendFile(reply: FastifyReply, file: ExportFile): FastifyReply {
  return reply
    .status(200)
    .header("content-type", file.contentType)
    .header("content-disposition", exportDisposition(file))
    .header("cache-control", "no-store")
    .send(Readable.from(file.body));
}
