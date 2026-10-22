import { z } from "zod";
import { backupHeaderSchema, droppedPreferenceSchema, LIBRARY_CATEGORIES, REPLACEABLE_SETTINGS } from "../backup.ts";
import { appErrorSchema } from "../errors.ts";
import { fileGrantSchema } from "./local-media.ts";

/** Client backup export, restore readiness and the update-install maintenance state. */

const countSchema = z.number().int().nonnegative();
const idSchema = z.string().min(1).max(64);

/** `POST /api/backup/estimate` [client]. */
export const backupEstimateRequestSchema = z.object({ includeOriginals: z.boolean(), includeCache: z.boolean() }).strict();
export type BackupEstimateRequest = z.infer<typeof backupEstimateRequestSchema>;

/** Why an original cannot be read right now; such an original must be excluded explicitly or relinked. */
export const UNREADABLE_ORIGINAL_REASONS = ["missing", "not_a_file", "unreadable"] as const;
export type UnreadableOriginalReason = (typeof UNREADABLE_ORIGINAL_REASONS)[number];

/** Sizes are the registered `sizeBytes`; the export copies what is on disk then and logs any difference. */
export const backupEstimateDtoSchema = z
  .object({
    database: z.object({ bytes: countSchema }).strict(),
    originals: z
      .object({
        count: countSchema,
        bytes: countSchema,
        unreadable: z.array(z.object({ assetId: idSchema, displayName: z.string(), reason: z.enum(UNREADABLE_ORIGINAL_REASONS) }).strict()),
      })
      .strict(),
    cache: z.object({ count: countSchema, bytes: countSchema }).strict(),
  })
  .strict();
export type BackupEstimateDto = z.infer<typeof backupEstimateDtoSchema>;

/**
 * `POST /api/backup/exports` [client]: `grant` is the shell's `backup_output` grant for the file
 * the user chose. It is optional in the schema only so that a missing grant answers
 * `unauthenticated.file_grant` like a forged or expired one, not a schema error.
 */
export const backupExportRequestSchema = z
  .object({
    grant: fileGrantSchema.exactOptional(),
    includeOriginals: z.boolean(),
    includeCache: z.boolean(),
    excludeOriginals: z.array(idSchema).max(100000).default([]),
    uiPreferences: z.record(z.string(), z.string()).default({}),
  })
  .strict();
export type BackupExportRequest = z.input<typeof backupExportRequestSchema>;

/** 202 answer: the job id and the UI preferences the backup will not carry, with the reason for each. */
export const backupExportAcceptedDtoSchema = z.object({ jobId: idSchema, preferencesDropped: z.array(droppedPreferenceSchema) }).strict();
export type BackupExportAcceptedDto = z.infer<typeof backupExportAcceptedDtoSchema>;

export const BACKUP_EXPORT_STATUSES = ["running", "succeeded", "failed", "cancelled"] as const;
export type BackupExportStatus = (typeof BACKUP_EXPORT_STATUSES)[number];

/** `snapshot`: `VACUUM INTO` and stripping; `originals` / `cache`: copying files; `finalize`: manifest, sync, rename. */
export const BACKUP_EXPORT_PHASES = ["snapshot", "originals", "cache", "finalize"] as const;
export type BackupExportPhase = (typeof BACKUP_EXPORT_PHASES)[number];

/**
 * `GET /api/backup/exports/:id` [client]. Jobs live in the sidecar's memory only. `failedAsset`
 * names the original or cache file whose content no longer matched (`media_changed`).
 */
export const backupExportJobDtoSchema = z
  .object({
    jobId: idSchema,
    status: z.enum(BACKUP_EXPORT_STATUSES),
    phase: z.enum(BACKUP_EXPORT_PHASES),
    bytesDone: countSchema,
    bytesTotal: countSchema,
    filesDone: countSchema,
    filesTotal: countSchema,
    error: appErrorSchema.exactOptional(),
    failedAsset: z.object({ assetId: idSchema, displayName: z.string() }).strict().exactOptional(),
    result: z
      .object({
        sizeBytes: countSchema,
        originals: countSchema,
        cache: countSchema,
        preferencesDropped: z.array(droppedPreferenceSchema),
      })
      .strict()
      .exactOptional(),
  })
  .strict();
export type BackupExportJobDto = z.infer<typeof backupExportJobDtoSchema>;

/** `GET /api/backup/restore-readiness` [client]: `willReplace` lists the settings that differ from their defaults. */
export const restoreReadinessDtoSchema = z
  .object({
    fresh: z.boolean(),
    nonEmpty: z.array(z.enum(LIBRARY_CATEGORIES)),
    willReplace: z.array(z.enum(REPLACEABLE_SETTINGS)),
  })
  .strict();
export type RestoreReadinessDto = z.infer<typeof restoreReadinessDtoSchema>;

/** `GET /api/system/activity` [client]: for display only, never an admission check. */
export const systemActivityDtoSchema = z
  .object({ unfinishedTasks: countSchema, chatInflight: z.boolean(), backupExport: z.boolean() })
  .strict();
export type SystemActivityDto = z.infer<typeof systemActivityDtoSchema>;

/** `POST /api/system/maintenance` [client]. */
export const maintenanceRequestSchema = z.object({ reason: z.literal("update_install") }).strict();
export type MaintenanceRequest = z.infer<typeof maintenanceRequestSchema>;

/** The maintenance state lasts until `until` (Unix ms) unless released earlier. */
export const maintenanceDtoSchema = z.object({ until: z.number().int().positive() }).strict();
export type MaintenanceDto = z.infer<typeof maintenanceDtoSchema>;

// The offline restore command (`node server.js restore inspect | apply | recover`) writes one
// of these reports as JSON to its `--report` file; the shell hands it to the web client
// unchanged. Progress goes to stdout as `RESTORE_PROGRESS_PREFIX` + JSON lines.

export { RESTORE_PROGRESS_PREFIX } from "../backup-names.ts";

export const RESTORE_PHASES = ["verify", "stage", "originals", "cache", "database", "cleanup"] as const;
export type RestorePhase = (typeof RESTORE_PHASES)[number];

export const restoreProgressSchema = z.object({ phase: z.enum(RESTORE_PHASES), done: countSchema, total: countSchema }).strict();
export type RestoreProgress = z.infer<typeof restoreProgressSchema>;

const failedReportSchema = z.object({ ok: z.literal(false), error: appErrorSchema }).strict();

/** `inspect`: the header only, read from the first entry; the archive is verified in full by `apply`. */
export const restoreInspectReportSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), header: backupHeaderSchema }).strict(),
  failedReportSchema,
]);
export type RestoreInspectReport = z.infer<typeof restoreInspectReportSchema>;

/**
 * `apply`: what was restored. `preferences.candidates` are the whitelisted UI preferences the
 * web client writes to local storage itself; `dropped` are the ones the archive carried but
 * the whitelist refused.
 */
export const restoreApplyReportSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      database: z.literal("ok"),
      restored: z
        .object({
          contents: countSchema,
          collections: countSchema,
          notes: countSchema,
          originals: countSchema,
          cache: countSchema,
          missingOriginals: countSchema,
          profilesNeedingCredentials: countSchema,
        })
        .strict(),
      originalsDir: z.string().min(1).nullable(),
      preferences: z.object({ candidates: z.record(z.string(), z.string()), dropped: z.array(droppedPreferenceSchema) }).strict(),
    })
    .strict(),
  failedReportSchema,
]);
export type RestoreApplyReport = z.infer<typeof restoreApplyReportSchema>;

/**
 * `recover` (also run by the sidecar before it opens the database): `rolled_back` undid an
 * interrupted restore, `completed` finished one past its commit point, `manual_required`
 * means the journal could not be trusted and nothing was touched.
 */
export const RESTORE_RECOVERY_OUTCOMES = ["nothing_to_do", "rolled_back", "completed", "manual_required"] as const;
export type RestoreRecoveryOutcome = (typeof RESTORE_RECOVERY_OUTCOMES)[number];

export const restoreRecoverReportSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), outcome: z.enum(RESTORE_RECOVERY_OUTCOMES) }).strict(),
  failedReportSchema,
]);
export type RestoreRecoverReport = z.infer<typeof restoreRecoverReportSchema>;
