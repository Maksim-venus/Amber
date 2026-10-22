import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { monotonicFactory } from "ulid";
import { filterUiPreferences, BACKUP_DATABASE_ENTRY, RESTORED_ORIGINALS_DIR_PREFIX, type BackupHeader } from "../shared/backup.ts";
import { CACHE_DIR_NAME } from "../shared/app-identity.ts";
import {
  RESTORE_PROGRESS_PREFIX,
  type RestoreApplyReport,
  type RestoreInspectReport,
  type RestorePhase,
  type RestoreRecoverReport,
  type RestoreRecoveryOutcome,
} from "../shared/dto/backup.ts";
import type { AppError } from "../shared/errors.ts";
import { readBackupHeader, unpackBackup } from "./adapters/backup/archive-reader.ts";
import {
  createJournal,
  readJournal,
  removeJournal,
  RESTORE_JOURNAL_FILE,
  RESTORE_JOURNAL_FORMAT_VERSION,
  writeJournal,
  type RestoreJournalBody,
  type RestoreMove,
} from "./adapters/backup/journal.ts";
import { assignOriginalNames, copyFileExclusive, hasIdentity, volumesWithoutSpace } from "./adapters/backup/restore-files.ts";
import { dataDirLayout } from "./adapters/file-store/data-dir.ts";
import { LiveDatabase, StagedDatabase } from "./adapters/sqlite/restore-store.ts";
import { amberError, appError, isAmberError } from "./domain/errors.ts";

/**
 * The offline restore command: `node server.js restore inspect | apply | recover`.
 * The desktop shell runs it with the sidecar stopped; it never composes the backend.
 *
 * - `inspect --archive <path> --report <path>`: reads the header only.
 * - `apply --archive <path> --data-dir <dir> [--originals-dir <dir>] --report <path>`: verifies and
 *   restores into a fresh data directory; progress lines go to stdout.
 * - `recover --data-dir <dir> --report <path>`: settles an interrupted restore.
 *
 * Each subcommand writes its JSON report (`restore*ReportSchema`, shared/dto/backup.ts) and exits
 * 0 when the report is `ok`, 1 otherwise.
 */
export async function runRestoreCommand(argv: readonly string[]): Promise<number> {
  const [subcommand, ...rest] = argv;
  let args: Map<string, string>;
  try {
    args = parseArgs(rest);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const report = args.get("report");
  if (report === undefined) {
    process.stderr.write("--report is required\n");
    return 2;
  }
  let result: RestoreInspectReport | RestoreApplyReport | RestoreRecoverReport;
  switch (subcommand) {
    case "inspect":
      result = inspectRestore(required(args, "archive"));
      break;
    case "apply": {
      const originalsDir = args.get("originals-dir");
      result = applyRestore({
        archive: required(args, "archive"),
        dataDir: required(args, "data-dir"),
        ...(originalsDir === undefined ? {} : { originalsDir }),
        onProgress: (progress) => process.stdout.write(`${RESTORE_PROGRESS_PREFIX}${JSON.stringify(progress)}\n`),
      });
      break;
    }
    case "recover":
      result = recoverRestore(required(args, "data-dir"));
      break;
    default:
      process.stderr.write(`unknown restore subcommand: ${String(subcommand)}\n`);
      return 2;
  }
  writeFileSync(report, `${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

/**
 * Settles an interrupted restore of `dataDir` before the sidecar opens its database; a no-op
 * without a journal. Never throws for a damaged journal: it is left alone for manual handling.
 */
export async function recoverInterruptedRestore(dataDir: string): Promise<RestoreRecoveryOutcome> {
  try {
    return settleRestore(dataDir);
  } catch {
    return "manual_required";
  }
}

function parseArgs(rest: readonly string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i] as string;
    const value = rest[i + 1];
    if (!flag.startsWith("--") || value === undefined) {
      throw new Error(`malformed argument: ${flag}`);
    }
    args.set(flag.slice(2), value);
  }
  return args;
}

function required(args: Map<string, string>, name: string): string {
  const value = args.get(name);
  if (value === undefined || value === "") {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function asAppError(error: unknown): AppError {
  return isAmberError(error) ? error.appError : appError("internal");
}

export function inspectRestore(archive: string): RestoreInspectReport {
  try {
    return { ok: true, header: readBackupHeader(archive) };
  } catch (error) {
    return { ok: false, error: asAppError(error) };
  }
}

export function recoverRestore(dataDir: string): RestoreRecoverReport {
  try {
    return { ok: true, outcome: settleRestore(dataDir) };
  } catch (error) {
    return { ok: false, error: asAppError(error) };
  }
}

/** Points where a test may stop a restore as a crash would, to prove recovery from each. */
export const RESTORE_CHECKPOINTS = [
  "unpacking",
  "original_partial_written",
  "original_renamed",
  "cache_renamed",
  "database_moved_aside",
  "database_renamed",
  "finished",
] as const;
export type RestoreCheckpoint = (typeof RESTORE_CHECKPOINTS)[number];

/**
 * Thrown by a checkpoint hook to stop the restore where it stands, as a crash would: nothing
 * is rolled back, open files are only closed.
 */
export class RestoreHalted extends Error {}

export interface ApplyOptions {
  archive: string;
  dataDir: string;
  originalsDir?: string;
  onProgress?: (progress: { phase: RestorePhase; done: number; total: number }) => void;
  checkpoint?: (point: RestoreCheckpoint) => void;
  now?: () => number;
}

const newId = monotonicFactory();
const STAGING_NAME = /^[0-9A-Za-z_-]{1,64}$/u;

function restoreRoot(dataDir: string): string {
  return join(dataDir, "tmp", "restore");
}

/** `pre-restore-<yyyyMMdd-HHmmss>` in UTC, the stem the replaced database files keep under `backups/`. */
function previousDatabaseStem(now: number): string {
  const iso = new Date(now).toISOString();
  return `pre-restore-${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
}

/** The live database files and the names they are moved to. */
function databaseFiles(dataDir: string, stem: string): Array<{ live: string; aside: string }> {
  const layout = dataDirLayout(dataDir);
  return ["", "-wal", "-shm"].map((suffix) => ({ live: `${layout.database}${suffix}`, aside: join(layout.backups, `${stem}.db${suffix}`) }));
}

function isInside(parent: string, child: string): boolean {
  const fold = (path: string): string => (process.platform === "win32" ? path.toLowerCase() : path);
  const path = relative(fold(parent), fold(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/**
 * The directory the originals go to: a new `Amber-Restored-…` subdirectory of an existing
 * directory reached without any link, outside the data directory.
 */
function checkOriginalsDir(originalsDir: string, dataDir: string): string {
  const target = resolve(originalsDir);
  const parent = dirname(target);
  const bad = (reason: string) => amberError("invalid_request", reason, { params: { detail: "originals directory" } });
  if (!basename(target).startsWith(RESTORED_ORIGINALS_DIR_PREFIX)) {
    throw bad("the originals directory is not a restore subdirectory");
  }
  let real: string;
  try {
    real = realpathSync(parent);
  } catch {
    throw bad("the chosen directory does not exist");
  }
  const same = process.platform === "win32" ? real.toLowerCase() === parent.toLowerCase() : real === parent;
  if (!same || !lstatSync(parent).isDirectory()) {
    throw bad("the chosen directory is reached through a link");
  }
  if (existsSync(target) || isLink(target)) {
    throw bad("the originals directory already exists");
  }
  if (isInside(resolve(dataDir), target)) {
    throw bad("the originals directory lies inside the data directory");
  }
  return target;
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Restores `archive` into the fresh data directory `dataDir`. The commit protocol, in order:
 *   1. `tmp/restore/journal.json` is created exclusively; it doubles as the lock, so an
 *      existing journal means another restore, which `recover` settles first.
 *   2. The old database, when there is one, is opened with `BEGIN IMMEDIATE` to prove nobody
 *      else writes it, and must hold no library data (only a fresh install is a target); the
 *      originals directory grant and the free space of each volume involved are checked.
 *   3. The archive is unpacked into `tmp/restore/<id>/`: absolute paths, `..`, links,
 *      devices and paths the header does not list are refused; every entry is checked
 *      against its manifest SHA-256 and each original also against its fingerprint. A schema
 *      newer than this build is refused and an older one is migrated in the staged database,
 *      which must then pass `integrity_check` and `foreign_key_check` and have every
 *      `[[seg:]]` marker resolve. The originals' `storageRef` is rewritten inside the staged
 *      database only.
 *   4. Files are moved: each original goes through `<to>.partial`, `fsync`, rename and an
 *      `lstat` identity check; cache files are renamed into the default cache directory.
 *   5. The old `amber.db` and its existing `-wal` / `-shm` files are renamed to
 *      `backups/pre-restore-*`, never deleted.
 *   6. The staged database is renamed to `amber.db`: the commit point of what the database
 *      shows.
 *   7. Staging and journal are removed and the report is returned.
 * The journal (`adapters/backup/journal.ts`) records each phase. Every failure before the
 * commit point rolls back to the state before the restore, and the journal makes the same
 * true after a crash; a rollback deletes only files this restore created and whose identity
 * still matches.
 */
export function applyRestore(options: ApplyOptions): RestoreApplyReport {
  const now = options.now ?? Date.now;
  const dataDir = resolve(options.dataDir);
  const layout = dataDirLayout(dataDir);
  const root = restoreRoot(dataDir);
  const journalPath = join(root, RESTORE_JOURNAL_FILE);
  const progress = (phase: RestorePhase, done: number, total: number): void => options.onProgress?.({ phase, done, total });
  const checkpoint = (point: RestoreCheckpoint): void => options.checkpoint?.(point);

  let header: BackupHeader;
  try {
    progress("verify", 0, 1);
    header = readBackupHeader(options.archive);
  } catch (error) {
    return { ok: false, error: asAppError(error) };
  }
  if (header.originals.length > 0 && options.originalsDir === undefined) {
    return { ok: false, error: appError("invalid_request", { params: { detail: "originals directory" } }) };
  }

  mkdirSync(root, { recursive: true });
  const id = newId();
  let body: RestoreJournalBody = {
    formatVersion: RESTORE_JOURNAL_FORMAT_VERSION,
    id,
    phase: "staged",
    createdAt: now(),
    stagingDir: id,
    originalsDir: null,
    previousDatabase: previousDatabaseStem(now()),
    moves: [],
  };
  try {
    createJournal(journalPath, body);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { ok: false, error: appError("conflict", { code: "conflict.backup_in_progress" }) };
    }
    return { ok: false, error: appError("internal") };
  }
  const update = (next: Partial<RestoreJournalBody>): void => {
    body = { ...body, ...next };
    writeJournal(journalPath, body);
  };

  let live: LiveDatabase | undefined;
  let staged: StagedDatabase | undefined;
  try {
    live = existsSync(layout.database) ? LiveDatabase.open(layout.database) : undefined;
    const nonEmpty = live?.nonEmptyCategories() ?? [];
    if (nonEmpty.length > 0) {
      throw amberError("conflict", "the target is not a fresh install", { code: "conflict.library_not_empty", details: { nonEmpty } });
    }
    const originalsDir = header.originals.length === 0 ? null : checkOriginalsDir(options.originalsDir as string, dataDir);
    if (originalsDir !== null) {
      update({ originalsDir });
    }
    const unpacked = header.sizes.database + header.sizes.originals + header.sizes.cache;
    const databaseBytes = existsSync(layout.database) ? statSync(layout.database).size : 0;
    const short = volumesWithoutSpace([
      { dir: root, bytes: unpacked + databaseBytes },
      ...(originalsDir === null ? [] : [{ dir: dirname(originalsDir), bytes: header.sizes.originals }]),
    ]);
    if (short.length > 0) {
      throw amberError("disk_low", "not enough free space to restore");
    }

    const stagingDir = join(root, body.stagingDir);
    mkdirSync(stagingDir);
    const fileCount = 1 + header.originals.length + header.cache.length;
    progress("stage", 0, fileCount);
    const { files } = unpackBackup(options.archive, stagingDir, {
      onFile: ({ files: done }) => {
        progress("stage", done, fileCount);
        checkpoint("unpacking");
      },
    });

    staged = StagedDatabase.open(join(stagingDir, BACKUP_DATABASE_ENTRY));
    staged.upgradeSchema(header);
    staged.verify();
    staged.checkMedia(header);
    const names = assignOriginalNames(header.originals);
    const targets = new Map(header.originals.map((original) => [original.assetId, join(originalsDir as string, names.get(original.assetId) as string)]));
    staged.relocateOriginals(targets);
    const counts = staged.counts();
    staged.close();
    staged = undefined;

    const cacheDir = join(dataDir, CACHE_DIR_NAME);
    const moves: RestoreMove[] = [
      ...header.originals.map((original): RestoreMove => {
        const file = files.get(original.archivePath);
        return { kind: "original", from: original.archivePath, to: targets.get(original.assetId) as string, sizeBytes: file?.sizeBytes ?? 0, sha256: file?.sha256 ?? "", state: "planned" };
      }),
      ...header.cache.map((cache): RestoreMove => {
        const file = files.get(cache.archivePath);
        const to = join(cacheDir, cache.archivePath.slice(cache.archivePath.indexOf("/") + 1));
        if (existsSync(to) || isLink(to)) {
          throw amberError("conflict", "a cache file of the backup already exists");
        }
        return { kind: "cache", from: cache.archivePath, to, sizeBytes: file?.sizeBytes ?? 0, sha256: file?.sha256 ?? "", state: "planned" };
      }),
    ];
    update({ moves });

    if (originalsDir !== null) {
      mkdirSync(originalsDir);
    }
    const originalMoves = moves.filter((move) => move.kind === "original");
    progress("originals", 0, originalMoves.length);
    let done = 0;
    for (const move of originalMoves) {
      copyFileExclusive(join(stagingDir, ...move.from.split("/")), move.to, { beforeRename: () => checkpoint("original_partial_written") });
      checkpoint("original_renamed");
      move.state = "done";
      update({ moves });
      done += 1;
      progress("originals", done, originalMoves.length);
    }
    const cacheMoves = moves.filter((move) => move.kind === "cache");
    progress("cache", 0, cacheMoves.length);
    done = 0;
    if (cacheMoves.length > 0) {
      mkdirSync(cacheDir, { recursive: true });
    }
    for (const move of cacheMoves) {
      if (existsSync(move.to) || isLink(move.to)) {
        throw amberError("conflict", "a cache file of the backup already exists");
      }
      renameSync(join(stagingDir, ...move.from.split("/")), move.to);
      checkpoint("cache_renamed");
      move.state = "done";
      update({ moves });
      done += 1;
      progress("cache", done, cacheMoves.length);
    }
    update({ phase: "files_moved" });

    progress("database", 0, 1);
    live?.close();
    live = undefined;
    mkdirSync(layout.backups, { recursive: true });
    for (const file of databaseFiles(dataDir, body.previousDatabase)) {
      if (existsSync(file.live)) {
        renameSync(file.live, file.aside);
      }
    }
    update({ phase: "db_moved" });
    checkpoint("database_moved_aside");
    renameSync(join(stagingDir, BACKUP_DATABASE_ENTRY), layout.database);
    checkpoint("database_renamed");
    update({ phase: "committed" });
    progress("database", 1, 1);

    progress("cleanup", 0, 1);
    try {
      finishCommitted(dataDir, body);
    } catch {
      // Past the commit point the restore stands; the next start finishes the cleanup.
    }
    progress("cleanup", 1, 1);
    checkpoint("finished");

    const { accepted, dropped } = filterUiPreferences(header.uiPreferences);
    return {
      ok: true,
      database: "ok",
      restored: {
        contents: counts.contents,
        collections: counts.collections,
        notes: counts.notes,
        originals: originalMoves.length,
        cache: cacheMoves.length,
        missingOriginals: counts.missingOriginals,
        profilesNeedingCredentials: counts.profilesNeedingCredentials,
      },
      originalsDir,
      preferences: { candidates: accepted, dropped },
    };
  } catch (error) {
    staged?.close();
    live?.abandon();
    if (error instanceof RestoreHalted) {
      throw error;
    }
    if (body.phase !== "committed") {
      try {
        settleRestore(dataDir);
      } catch {
        // The journal stays; the next start or a `recover` settles it.
      }
    }
    return { ok: false, error: asAppError(error) };
  }
}

/**
 * Crash recovery: settles whatever restore the journal records. Before the commit
 * point everything this restore wrote is removed again and the replaced database is put back;
 * after it only the cleanup is finished. Each step is idempotent, and only files whose size
 * and hash match the journal are ever deleted.
 */
export function settleRestore(dataDir: string): RestoreRecoveryOutcome {
  const absolute = resolve(dataDir);
  const journalPath = join(restoreRoot(absolute), RESTORE_JOURNAL_FILE);
  const journal = readJournal(journalPath);
  if (journal === undefined) {
    // A temporary journal without a journal is an update that never got renamed into place.
    rmSync(`${journalPath}.tmp`, { force: true });
    return "nothing_to_do";
  }
  if (journal === "damaged" || !STAGING_NAME.test(journal.stagingDir)) {
    return "manual_required";
  }
  const { checksum: _checksum, ...body } = journal;
  const stagedDatabase = join(restoreRoot(absolute), body.stagingDir, BACKUP_DATABASE_ENTRY);
  const committed =
    body.phase === "committed" || (body.phase === "db_moved" && existsSync(dataDirLayout(absolute).database) && !existsSync(stagedDatabase));
  if (committed) {
    finishCommitted(absolute, body);
    return "completed";
  }
  rollBack(absolute, body);
  return "rolled_back";
}

function finishCommitted(dataDir: string, body: RestoreJournalBody): void {
  rmSync(join(restoreRoot(dataDir), body.stagingDir), { recursive: true, force: true });
  removeJournal(join(restoreRoot(dataDir), RESTORE_JOURNAL_FILE));
  removeIfEmpty(restoreRoot(dataDir));
}

function removeIfEmpty(dir: string): void {
  try {
    rmdirSync(dir);
  } catch {
    // Not empty, or already gone.
  }
}

function rollBack(dataDir: string, body: RestoreJournalBody): void {
  for (const file of databaseFiles(dataDir, body.previousDatabase)) {
    if (existsSync(file.aside) && !existsSync(file.live)) {
      renameSync(file.aside, file.live);
    }
  }
  for (const move of body.moves) {
    if (hasIdentity(move.to, move.sizeBytes, move.sha256)) {
      rmSync(move.to);
    }
    const partial = `${move.to}.partial`;
    if (move.kind === "original" && isRegularFile(partial)) {
      rmSync(partial);
    }
  }
  if (body.originalsDir !== null && existsSync(body.originalsDir) && readdirSync(body.originalsDir).length === 0) {
    removeIfEmpty(body.originalsDir);
  }
  rmSync(join(restoreRoot(dataDir), body.stagingDir), { recursive: true, force: true });
  removeJournal(join(restoreRoot(dataDir), RESTORE_JOURNAL_FILE));
  removeIfEmpty(restoreRoot(dataDir));
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}
