import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  backupEstimateDtoSchema,
  backupEstimateRequestSchema,
  backupExportAcceptedDtoSchema,
  backupExportJobDtoSchema,
  backupExportRequestSchema,
  restoreReadinessDtoSchema,
} from "../../../shared/dto/backup.ts";
import type { BackupExportService } from "../../application/backup-export.ts";
import type { RestoreReadinessService } from "../../application/restore-readiness.ts";
import { principalOf } from "../auth.ts";
import { parseInput, sendValidated } from "../validation.ts";

const jobParamsSchema = z.object({ id: z.string().min(1).max(64) });

/**
 * The `[client]` backup endpoints, registered in local mode only.
 * Restoring is an offline command run by the desktop shell and has no endpoint.
 */
export function registerBackupRoutes(app: FastifyInstance, deps: { backupExport: BackupExportService; restoreReadiness: RestoreReadinessService }): void {
  app.post("/api/backup/estimate", async (request, reply) => {
    const body = parseInput(backupEstimateRequestSchema, request.body, "body");
    return sendValidated(reply, 200, backupEstimateDtoSchema, deps.backupExport.estimate(body));
  });

  // 202: the archive is written after the answer; `GET /backup/exports/:id` reports progress.
  app.post("/api/backup/exports", async (request, reply) => {
    const body = parseInput(backupExportRequestSchema, request.body, "body");
    return sendValidated(reply, 202, backupExportAcceptedDtoSchema, deps.backupExport.start(body));
  });

  app.get("/api/backup/exports/:id", async (request, reply) => {
    const { id } = parseInput(jobParamsSchema, request.params, "params");
    return sendValidated(reply, 200, backupExportJobDtoSchema, deps.backupExport.get(id));
  });

  app.post("/api/backup/exports/:id/cancel", async (request, reply) => {
    const { id } = parseInput(jobParamsSchema, request.params, "params");
    return sendValidated(reply, 200, backupExportJobDtoSchema, await deps.backupExport.cancel(id));
  });

  app.get("/api/backup/restore-readiness", async (request, reply) => {
    return sendValidated(reply, 200, restoreReadinessDtoSchema, deps.restoreReadiness.get(principalOf(request)));
  });
}
