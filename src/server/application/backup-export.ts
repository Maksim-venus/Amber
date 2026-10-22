import { accessSync, constants, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, win32 } from "node:path";
import { monotonicFactory } from "ulid";
import { z } from "zod";
import {
  BACKUP_DATABASE_ENTRY,
  BACKUP_FILE_EXTENSION,
  backupHeaderSchema,
  cacheArchivePath,
  type BackupHeader,
  type DroppedPreference,
  filterUiPreferences,
  originalArchivePath,
} from "../../shared/backup.ts";
import { cacheFileNameOf } from "../../shared/cache-file-name.ts";
import { BACKUP_HEADER_MAX_BYTES } from "../../shared/defaults.ts";
import type {
  BackupEstimateDto,
  BackupEstimateRequest,
  BackupExportAcceptedDto,
  BackupExportJobDto,
  BackupExportPhase,
  BackupExportRequest,
  UnreadableOriginalReason,
} from "../../shared/dto/backup.ts";
import { backupExportRequestSchema } from "../../shared/dto/backup.ts";
import { amberError, appError } from "../domain/errors.ts";
import type { BackupArchiveFile, BackupArchiveWriter, BackupMediaRow, BackupStore } from "../ports/backup.ts";
import type { FileGrantVerifier } from "../ports/file-grant.ts";
import type { Logger } from "../ports/logger.ts";
import type { Repository } from "../ports/repository.ts";
import type { CacheGate, Release } from "../pipeline/cache-gate.ts";
import { gateConflict } from "../pipeline/gate-conflict.ts";
import { toAppError } from "../pipeline/retry.ts";

/**
 * FAT and DrvFs keep modification times to whole seconds (FAT to two), so a partial archive
 * written right after the job started may carry an earlier time than the job record.
 */
const RECORD_TIME_SLACK_MS = 2000;

/** The record a job leaves in `tmp/export/` so a crash's leftovers can be found on the next start. */
const jobRecordSchema = z.object({ jobId: z.string().min(1), target: z.string().min(1), startedAt: z.number().int() });
type JobRecord = z.infer<typeof jobRecordSchema>;

export interface BackupExportServiceOptions {
  repository: Repository;
  store: BackupStore;
  writer: BackupArchiveWriter;
  grants: FileGrantVerifier;
  gate: Pick<CacheGate, "tryExclusive" | "exclusiveReason">;
  /** The video cache: where a `platform_cache` file is, and whether its directory is reachable. */
  cache: { pathOf(ref: string): string; isAvailableSync(): boolean };
  chat: { hasAnyInflight(): boolean };
  /** False until the start-up sweep and recovery have finished. */
  backgroundReady: () => boolean;
  /** `<data dir>/tmp/export`: job records and the per-job staging directories. */
  exportDir: string;
  version: string;
  logger: Logger;
  now?: () => number;
  newId?: () => string;
  /** Free bytes of the volume holding `path`. */
  freeBytes?: (path: string) => number;
}

interface Job {
  dto: BackupExportJobDto;
  controller: AbortController;
  done: Promise<void>;
}

function freeBytesOf(path: string): number {
  const stats = statfsSync(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** The file name of a path written on either platform. */
function fileNameOf(path: string): string {
  return win32.basename(path.replace(/\\/g, "/"));
}

/** Why an original cannot be copied right now, or `undefined` when it can. */
function unreadableReason(path: string): UnreadableOriginalReason | undefined {
  let isFile: boolean;
  try {
    isFile = statSync(path).isFile();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
  if (!isFile) {
    return "not_a_file";
  }
  try {
    accessSync(path, constants.R_OK);
    return undefined;
  } catch {
    return "unreadable";
  }
}

function displayNameOf(row: BackupMediaRow): string {
  return row.displayName ?? fileNameOf(row.storageRef);
}

function sameVolume(a: string, b: string): boolean {
  try {
    return statSync(a).dev === statSync(b).dev;
  } catch {
    return true;
  }
}

/**
 * The client backup export. Admission runs in one synchronous turn, so no
 * request can slip between its checks and the database snapshot; the exclusive cache lease
 * it takes is held until the job ends, which keeps every cache file the snapshot names in
 * place. The live database is only read: the snapshot is stripped as a copy. Jobs live in
 * memory; a restart forgets them and removes what they left behind.
 */
export class BackupExportService {
  private readonly options: BackupExportServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly freeBytes: (path: string) => number;
  private readonly jobs = new Map<string, Job>();
  private running: Job | undefined;

  constructor(options: BackupExportServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
    this.freeBytes = options.freeBytes ?? freeBytesOf;
  }

  /** Whether an export is running. */
  active(): boolean {
    return this.running !== undefined;
  }

  /** `POST /backup/estimate`: registered sizes; the export copies what is on disk at its time. */
  estimate(body: BackupEstimateRequest): BackupEstimateDto {
    const { originals, caches } = this.options.store.listBackupMedia();
    const included = body.includeOriginals ? originals : [];
    const cached = body.includeCache ? caches : [];
    return {
      database: { bytes: this.options.store.databaseBytes() },
      originals: {
        count: included.length,
        bytes: included.reduce((sum, row) => sum + row.sizeBytes, 0),
        unreadable: included.flatMap((row) => {
          const reason = unreadableReason(row.storageRef);
          return reason === undefined ? [] : [{ assetId: row.assetId, displayName: displayNameOf(row), reason }];
        }),
      },
      cache: { count: cached.length, bytes: cached.reduce((sum, row) => sum + row.sizeBytes, 0) },
    };
  }

  /**
   * `POST /backup/exports`: admits a job and starts it, all checks in one synchronous turn
   * so no other request can run between them. After the destination grant is verified, in
   * order:
   *   1. the start-up sweep and recovery have finished (`conflict.starting_up`);
   *   2. no export is running (`conflict.backup_in_progress`);
   *   3. the exclusive lease of the cache gate is taken (`conflict.cache_migrating` while a
   *      cache move holds it, `conflict.maintenance` in the maintenance state,
   *      `conflict.tasks_still_running` while Task drivers, deletions or eviction hold shared
   *      leases);
   *   4. no Task is unfinished (`conflict.tasks_unfinished`);
   *   5. no chat answer is in flight (`conflict.chat_inflight`), and, when caches are
   *      included, the cache directory is reachable (`conflict.cache_unavailable`);
   *   6. the destination volume, and the staging volume when it differs, has enough free
   *      space (`disk_low`);
   *   7. every original to include is readable right now (`media_changed`, estimate again);
   *   8. `VACUUM INTO` writes a consistent database snapshot to `tmp/export/<jobId>/`.
   * The exclusive lease is held until the job ends; it is the only barrier keeping the
   * snapshot and the cache files consistent, because every path that deletes an available
   * `platform_cache` file goes through the gate. Database writes such as notes and settings
   * go on during the export; they are simply not in this snapshot. Throws the first check
   * that fails, leaving nothing behind.
   */
  start(input: BackupExportRequest): BackupExportAcceptedDto {
    const body = backupExportRequestSchema.parse(input);
    const target = this.checkTarget(body.grant);
    if (!this.options.backgroundReady()) {
      throw amberError("conflict", "start-up sweep still running", { code: "conflict.starting_up" });
    }
    if (this.running !== undefined) {
      throw amberError("conflict", "an export is already running", { code: "conflict.backup_in_progress" });
    }
    const release = this.options.gate.tryExclusive("backup_export");
    if (release === undefined) {
      if (this.options.gate.exclusiveReason() !== undefined) {
        throw gateConflict(this.options.gate);
      }
      throw amberError("conflict", "tasks hold the cache", { code: "conflict.tasks_still_running" });
    }
    try {
      return this.admit(body, target, release);
    } catch (error) {
      release();
      throw error;
    }
  }

  get(jobId: string): BackupExportJobDto {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      throw amberError("not_found", "no such export job");
    }
    return structuredClone(job.dto);
  }

  /** Stops a running job and removes its partial archive; a finished job is returned as it is. */
  async cancel(jobId: string): Promise<BackupExportJobDto> {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      throw amberError("not_found", "no such export job");
    }
    if (job.dto.status === "running") {
      job.controller.abort();
      await job.done;
    }
    return structuredClone(job.dto);
  }

  /** Cancels a running job before the database closes under it. */
  async close(): Promise<void> {
    const running = this.running;
    if (running !== undefined) {
      running.controller.abort();
      await running.done;
    }
  }

  /**
   * Start-up: removes what an interrupted job left. A partial archive is
   * deleted only when its job record names it, it ends in `.partial`, it is a regular file
   * and it was modified after the job started; anything else is kept and logged.
   */
  sweepLeftovers(): void {
    const dir = this.options.exportDir;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(dir, name);
      if (name.endsWith(".json")) {
        this.removeLeftover(path);
        rmSync(path, { force: true });
        continue;
      }
      // Staging directories hold only snapshot copies made by this service.
      if (lstatSync(path).isDirectory()) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  }

  private removeLeftover(recordPath: string): void {
    let record: JobRecord;
    try {
      record = jobRecordSchema.parse(JSON.parse(readFileSync(recordPath, "utf8")));
    } catch {
      this.options.logger.warn("backup_export_record_unreadable");
      return;
    }
    const partial = `${record.target}.partial`;
    const stats = lstatSync(partial, { throwIfNoEntry: false });
    if (stats === undefined) {
      return;
    }
    if (stats.isFile() && stats.mtimeMs + RECORD_TIME_SLACK_MS >= record.startedAt) {
      rmSync(partial, { force: true });
      this.options.logger.info("backup_export_leftover_removed", { jobId: record.jobId });
    } else {
      this.options.logger.warn("backup_export_leftover_kept", { jobId: record.jobId });
    }
  }

  /** The destination the shell's save dialog signed as a `backup_output` file grant, checked before anything is taken. */
  private checkTarget(grant: BackupExportRequest["grant"]): string {
    if (grant === undefined || !this.options.grants.verify(grant, { path: grant.path, purpose: "backup_output" })) {
      throw amberError("unauthenticated", "backup destination grant rejected", { code: "unauthenticated.file_grant" });
    }
    const target = grant.path;
    const invalid = (reason: string): never => {
      throw amberError("invalid_request", reason, { params: { detail: "grant.path" } });
    };
    if (!isAbsolute(target) && !win32.isAbsolute(target)) {
      invalid("backup destination is not absolute");
    }
    if (!target.toLowerCase().endsWith(`.${BACKUP_FILE_EXTENSION}`)) {
      invalid("backup destination has the wrong extension");
    }
    const existing = lstatSync(target, { throwIfNoEntry: false });
    // A link or junction would let the archive land somewhere the user did not pick.
    if (existing !== undefined && !existing.isFile()) {
      invalid("backup destination is not a regular file");
    }
    if (statSync(dirname(target), { throwIfNoEntry: false })?.isDirectory() !== true) {
      invalid("backup destination folder does not exist");
    }
    if (lstatSync(`${target}.partial`, { throwIfNoEntry: false }) !== undefined) {
      throw amberError("conflict", "a partial backup already exists at the destination", { code: "conflict.backup_in_progress" });
    }
    return target;
  }

  private admit(body: z.output<typeof backupExportRequestSchema>, target: string, release: Release): BackupExportAcceptedDto {
    const unfinished = this.options.repository.withTransaction((scope) => scope.tasks.listUnfinished().length);
    if (unfinished > 0) {
      throw amberError("conflict", "tasks are unfinished", { code: "conflict.tasks_unfinished" });
    }
    if (this.options.chat.hasAnyInflight()) {
      throw amberError("conflict", "a chat answer is streaming", { code: "conflict.chat_inflight" });
    }
    const { originals, caches } = this.options.store.listBackupMedia();
    const excluded = new Set(body.excludeOriginals);
    const excludedOriginals = body.includeOriginals ? originals.filter((row) => excluded.has(row.assetId)).map((row) => row.assetId) : [];
    const includedOriginals = body.includeOriginals ? originals.filter((row) => !excluded.has(row.assetId)) : [];
    const includedCaches = body.includeCache ? caches : [];
    if (includedCaches.length > 0 && !this.options.cache.isAvailableSync()) {
      throw amberError("conflict", "the cache directory is unavailable", { code: "conflict.cache_unavailable" });
    }

    const databaseBytes = this.options.store.databaseBytes();
    const fileBytes = [...includedOriginals, ...includedCaches].reduce((sum, row) => sum + row.sizeBytes, 0);
    mkdirSync(this.options.exportDir, { recursive: true });
    const destinationNeed = databaseBytes + fileBytes + BACKUP_HEADER_MAX_BYTES;
    const stagingNeed = databaseBytes;
    const destination = dirname(target);
    const enough = sameVolume(destination, this.options.exportDir)
      ? this.freeBytes(destination) >= destinationNeed + stagingNeed
      : this.freeBytes(destination) >= destinationNeed && this.freeBytes(this.options.exportDir) >= stagingNeed;
    if (!enough) {
      throw amberError("disk_low", "not enough free space for the backup");
    }
    const unreadable = includedOriginals.find((row) => unreadableReason(row.storageRef) !== undefined);
    if (unreadable !== undefined) {
      throw amberError("media_changed", "an original cannot be read; estimate again");
    }

    const { accepted, dropped } = filterUiPreferences(body.uiPreferences);
    const jobId = this.newId();
    const startedAt = this.now();
    const stagingDir = join(this.options.exportDir, jobId);
    const recordPath = join(this.options.exportDir, `${jobId}.json`);
    const databasePath = join(stagingDir, BACKUP_DATABASE_ENTRY);
    try {
      mkdirSync(stagingDir);
      writeFileSync(recordPath, JSON.stringify({ jobId, target, startedAt } satisfies JobRecord), { flag: "wx" });
      this.options.store.snapshotTo(databasePath);
    } catch (error) {
      rmSync(stagingDir, { recursive: true, force: true });
      rmSync(recordPath, { force: true });
      throw error;
    }

    const files: BackupArchiveFile[] = [
      ...includedOriginals.map((row) => ({
        kind: "original" as const,
        assetId: row.assetId,
        archivePath: originalArchivePath(row.assetId, fileNameOf(row.storageRef)),
        sourcePath: row.storageRef,
        sizeBytes: row.sizeBytes,
        ...(row.fingerprint === undefined ? {} : { fingerprint: row.fingerprint }),
      })),
      ...includedCaches.map((row) => ({
        kind: "cache" as const,
        assetId: row.assetId,
        archivePath: cacheArchivePath(cacheFileNameOf(row.storageRef)),
        sourcePath: this.options.cache.pathOf(row.storageRef),
        sizeBytes: row.sizeBytes,
      })),
    ];
    const controller = new AbortController();
    const job: Job = {
      dto: {
        jobId,
        status: "running",
        phase: "snapshot",
        bytesDone: 0,
        bytesTotal: databaseBytes + fileBytes,
        filesDone: 0,
        filesTotal: files.length + 1,
      },
      controller,
      done: Promise.resolve(),
    };
    this.jobs.set(jobId, job);
    this.running = job;
    const plan: ExportPlan = {
      target,
      createdAt: startedAt,
      databasePath,
      stagingDir,
      recordPath,
      files,
      rows: new Map([...includedOriginals, ...includedCaches].map((row) => [row.assetId, row])),
      excludedOriginals,
      includes: { originals: body.includeOriginals, cache: body.includeCache },
      uiPreferences: accepted,
      preferencesDropped: dropped,
      originalBytes: includedOriginals.reduce((sum, row) => sum + row.sizeBytes, 0),
      cacheBytes: includedCaches.reduce((sum, row) => sum + row.sizeBytes, 0),
    };
    // The answer goes out first; the job runs on, still holding the exclusive lease.
    job.done = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.run(job, plan))
      .finally(() => {
        release();
        rmSync(stagingDir, { recursive: true, force: true });
        rmSync(recordPath, { force: true });
        if (this.running === job) this.running = undefined;
      });
    return { jobId, preferencesDropped: dropped };
  }

  private async run(job: Job, plan: ExportPlan): Promise<void> {
    const signal = job.controller.signal;
    const setPhase = (phase: BackupExportPhase): void => {
      job.dto.phase = phase;
    };
    try {
      signal.throwIfAborted();
      const idsOf = (kind: BackupArchiveFile["kind"]): Set<string> => new Set(plan.files.filter((file) => file.kind === kind).map((file) => file.assetId));
      const summary = this.options.store.stripSnapshot(plan.databasePath, { includedOriginals: idsOf("original"), includedCaches: idsOf("cache") });
      const header = this.headerOf(plan, summary, statSync(plan.databasePath).size);
      const estimatedBytes = job.dto.bytesTotal;
      job.dto.bytesTotal = header.sizes.database + plan.originalBytes + plan.cacheBytes;
      const result = await this.options.writer.write({
        target: plan.target,
        header,
        databasePath: plan.databasePath,
        files: plan.files,
        signal,
        onProgress: (progress) => {
          setPhase(progress.phase);
          job.dto.bytesDone = progress.bytesDone;
          job.dto.filesDone = progress.filesDone;
        },
      });
      if (!result.ok) {
        const row = plan.rows.get(result.changedAssetId);
        job.dto.status = "failed";
        job.dto.error = appError("media_changed");
        job.dto.failedAsset = { assetId: result.changedAssetId, displayName: row === undefined ? "" : displayNameOf(row) };
        this.options.logger.warn("backup_export_media_changed", { jobId: job.dto.jobId, assetId: result.changedAssetId });
        return;
      }
      job.dto.status = "succeeded";
      job.dto.phase = "finalize";
      job.dto.bytesDone = job.dto.bytesTotal;
      job.dto.filesDone = job.dto.filesTotal;
      job.dto.result = {
        sizeBytes: result.sizeBytes,
        originals: header.originals.length,
        cache: header.cache.length,
        preferencesDropped: plan.preferencesDropped,
      };
      // The estimate summed registered sizes; the archive is what was actually written.
      this.options.logger.info("backup_export_finished", { jobId: job.dto.jobId, estimatedBytes, sizeBytes: result.sizeBytes });
    } catch (error) {
      if (signal.aborted) {
        job.dto.status = "cancelled";
        return;
      }
      job.dto.status = "failed";
      job.dto.error = toAppError(error);
      this.options.logger.error("backup_export_failed", { jobId: job.dto.jobId, code: job.dto.error.code });
    }
  }

  private headerOf(plan: ExportPlan, summary: { schemaVersion: number; contents: number; collections: number; notes: number }, databaseBytes: number): BackupHeader {
    const originals = plan.files.filter((file) => file.kind === "original");
    const cache = plan.files.filter((file) => file.kind === "cache");
    const header = backupHeaderSchema.safeParse({
      formatVersion: 1,
      mode: "local",
      amberVersion: this.options.version,
      schemaVersion: summary.schemaVersion,
      createdAt: plan.createdAt,
      encryption: "none",
      includes: plan.includes,
      excludedOriginals: [...plan.excludedOriginals].sort(),
      counts: { contents: summary.contents, collections: summary.collections, notes: summary.notes, originals: originals.length, cache: cache.length },
      sizes: { database: databaseBytes, originals: plan.originalBytes, cache: plan.cacheBytes },
      originals: originals.map((file) => ({
        assetId: file.assetId,
        archivePath: file.archivePath,
        originalName: basename(file.sourcePath.replace(/\\/g, "/")) || file.assetId,
        sizeBytes: file.sizeBytes,
        fingerprint: file.fingerprint ?? null,
      })),
      cache: cache.map((file) => ({ assetId: file.assetId, archivePath: file.archivePath })),
      uiPreferences: plan.uiPreferences,
    });
    if (!header.success || Buffer.byteLength(JSON.stringify(header.data)) > BACKUP_HEADER_MAX_BYTES) {
      throw amberError("backup_invalid", "backup header does not fit its schema or size cap");
    }
    return header.data;
  }
}

interface ExportPlan {
  target: string;
  createdAt: number;
  databasePath: string;
  stagingDir: string;
  recordPath: string;
  files: BackupArchiveFile[];
  rows: Map<string, BackupMediaRow>;
  excludedOriginals: string[];
  includes: { originals: boolean; cache: boolean };
  uiPreferences: Record<string, string>;
  preferencesDropped: DroppedPreference[];
  originalBytes: number;
  cacheBytes: number;
}
