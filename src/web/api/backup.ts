import { z } from "zod";
import {
  backupEstimateDtoSchema,
  backupExportAcceptedDtoSchema,
  backupExportJobDtoSchema,
  restoreReadinessDtoSchema,
  type BackupEstimateDto,
  type BackupEstimateRequest,
  type BackupExportAcceptedDto,
  type BackupExportJobDto,
  type BackupExportRequest,
  type RestoreReadinessDto,
} from "../../shared/dto/backup.ts";
import type { ApiClient } from "./client.ts";

/** The backup endpoints, registered only in local mode (the desktop client). */

export const backupKeys = {
  readiness: ["backup", "restore-readiness"] as const,
  estimate: (request: BackupEstimateRequest) => ["backup", "estimate", request.includeOriginals, request.includeCache] as const,
  job: (jobId: string) => ["backup", "export", jobId] as const,
};

export function estimateBackup(client: ApiClient, request: BackupEstimateRequest): Promise<BackupEstimateDto> {
  return client.post("/api/backup/estimate", backupEstimateDtoSchema, { body: request });
}

export function startBackupExport(client: ApiClient, request: BackupExportRequest): Promise<BackupExportAcceptedDto> {
  return client.post("/api/backup/exports", backupExportAcceptedDtoSchema, { body: request });
}

export function fetchBackupExport(client: ApiClient, jobId: string): Promise<BackupExportJobDto> {
  return client.get(`/api/backup/exports/${encodeURIComponent(jobId)}`, backupExportJobDtoSchema);
}

export async function cancelBackupExport(client: ApiClient, jobId: string): Promise<void> {
  await client.post(`/api/backup/exports/${encodeURIComponent(jobId)}/cancel`, z.unknown());
}

export function fetchRestoreReadiness(client: ApiClient): Promise<RestoreReadinessDto> {
  return client.get("/api/backup/restore-readiness", restoreReadinessDtoSchema);
}

/** Every local UI preference under Amber's namespace; the sidecar keeps only the whitelisted ones. */
export function localUiPreferences(): Record<string, string> {
  const preferences: Record<string, string> = {};
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key === null || !key.startsWith("amber.")) continue;
      const value = localStorage.getItem(key);
      if (value !== null) preferences[key] = value;
    }
  } catch {
    // Storage unavailable: the backup carries no preferences.
  }
  return preferences;
}
