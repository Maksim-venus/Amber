import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { mediaAssetDtoSchema } from "../../../shared/dto/content.ts";
import { cacheLocationDtoSchema, cacheLocationPutSchema, relinkRequestSchema, saveGrantDtoSchema } from "../../../shared/dto/local-media.ts";
import { burnOutputListDtoSchema, burnRequestSchema, cacheMediaRequestSchema } from "../../../shared/dto/media.ts";
import { taskAcceptedDtoSchema } from "../../../shared/dto/task.ts";
import type { CacheRootService } from "../../application/cache-root.ts";
import type { ClientMediaTaskService } from "../../application/client-media-tasks.ts";
import type { MediaAssetService } from "../../application/media-assets.ts";
import type { RelinkService } from "../../application/relink.ts";
import { principalOf } from "../auth.ts";
import { idempotencyKeyOf, parseInput, sendValidated } from "../validation.ts";
import { requestSignal } from "./contents.ts";

const contentParamsSchema = z.object({ id: z.string().min(1).max(64) });
const assetParamsSchema = z.object({ assetId: z.string().min(1).max(64) });

/**
 * The `[client]` media endpoints, registered in local mode only: caching a
 * platform video, burning subtitles, relinking a moved local file, the burn products
 * waiting to be saved out through the shell, and the video cache location.
 */
export function registerClientMediaRoutes(
  app: FastifyInstance,
  deps: { clientMedia: ClientMediaTaskService; media: MediaAssetService; relink: RelinkService; cacheRoot?: CacheRootService },
): void {
  app.post("/api/contents/:id/cache-media", async (request, reply) => {
    const { id } = parseInput(contentParamsSchema, request.params, "params");
    const body = parseInput(cacheMediaRequestSchema, request.body ?? {}, "body");
    const result = await deps.clientMedia.cacheMedia(principalOf(request), id, body, idempotencyKeyOf(request));
    return sendValidated(reply, result.status, taskAcceptedDtoSchema, result.body);
  });

  app.post("/api/contents/:id/burn", async (request, reply) => {
    const { id } = parseInput(contentParamsSchema, request.params, "params");
    const body = parseInput(burnRequestSchema, request.body, "body");
    const result = await deps.clientMedia.burn(principalOf(request), id, body, idempotencyKeyOf(request));
    return sendValidated(reply, result.status, taskAcceptedDtoSchema, result.body);
  });

  app.put("/api/media/:assetId/relink", async (request, reply) => {
    const { assetId } = parseInput(assetParamsSchema, request.params, "params");
    const body = parseInput(relinkRequestSchema, request.body, "body");
    return sendValidated(reply, 200, mediaAssetDtoSchema, await deps.relink.relink(principalOf(request), assetId, body, requestSignal(reply)));
  });

  app.get("/api/media/burn-outputs", async (request, reply) => {
    return sendValidated(reply, 200, burnOutputListDtoSchema, deps.media.listBurnOutputs(principalOf(request)));
  });

  app.post("/api/media/:assetId/save-grant", async (request, reply) => {
    const { assetId } = parseInput(assetParamsSchema, request.params, "params");
    return sendValidated(reply, 200, saveGrantDtoSchema, deps.media.saveGrant(principalOf(request), assetId));
  });

  const cacheRoot = deps.cacheRoot;
  if (cacheRoot === undefined) {
    return;
  }
  app.get("/api/media/cache-location", async (request, reply) => {
    return sendValidated(reply, 200, cacheLocationDtoSchema, await cacheRoot.status(principalOf(request)));
  });

  // 202: the copy runs on after the answer; the returned status carries its progress.
  app.put("/api/media/cache-location", async (request, reply) => {
    const body = parseInput(cacheLocationPutSchema, request.body, "body");
    return sendValidated(reply, 202, cacheLocationDtoSchema, await cacheRoot.change(principalOf(request), body));
  });
}
