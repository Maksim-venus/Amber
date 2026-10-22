import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { sha256HexSchema } from "../../../shared/backup.ts";
import { canonicalJson } from "../../domain/canonical-json.ts";

/**
 * The restore journal `tmp/restore/journal.json`. Created exclusively, so it is
 * also the lock that keeps a second restore out of the same data directory; every update is
 * written to a temporary file, synced and renamed over it. `checksum` is the SHA-256 of the
 * journal serialized without it, so a torn or edited journal is never acted upon.
 *
 * Phases advance `staged → files_moved → db_moved → committed`; renaming the staged database
 * to `amber.db` is the commit point. Recovery from each phase: before `db_moved`, remove the
 * files this restore wrote (identity-checked against `moves`) and the staging directory; at
 * `db_moved`, first rename the pre-restore database back; at `committed`, only clean up.
 */

export const RESTORE_JOURNAL_FORMAT_VERSION = 1;
export const RESTORE_JOURNAL_FILE = "journal.json";

export const RESTORE_JOURNAL_PHASES = ["staged", "files_moved", "db_moved", "committed"] as const;
export type RestoreJournalPhase = (typeof RESTORE_JOURNAL_PHASES)[number];

/**
 * One file the restore moves out of staging. `from` is relative to the staging directory, `to`
 * is absolute; `sizeBytes` and `sha256` are the identity a rollback checks before deleting `to`.
 */
export const restoreMoveSchema = z
  .object({
    kind: z.enum(["original", "cache"]),
    from: z.string().min(1),
    to: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    sha256: sha256HexSchema,
    state: z.enum(["planned", "done"]),
  })
  .strict();
export type RestoreMove = z.infer<typeof restoreMoveSchema>;

export const restoreJournalBodySchema = z
  .object({
    formatVersion: z.literal(RESTORE_JOURNAL_FORMAT_VERSION),
    id: z.string().min(1),
    phase: z.enum(RESTORE_JOURNAL_PHASES),
    createdAt: z.number().int().positive(),
    /** The staging directory's name under `tmp/restore/`. */
    stagingDir: z.string().min(1),
    /** The originals subdirectory this restore creates, or `null` when the backup has no originals. */
    originalsDir: z.string().min(1).nullable(),
    /** The stem the pre-restore database files are renamed to under `backups/`: `pre-restore-<time>`. */
    previousDatabase: z.string().min(1),
    moves: z.array(restoreMoveSchema),
  })
  .strict();
export type RestoreJournalBody = z.infer<typeof restoreJournalBodySchema>;

export const restoreJournalSchema = restoreJournalBodySchema.extend({ checksum: sha256HexSchema }).strict();
export type RestoreJournal = z.infer<typeof restoreJournalSchema>;

/** The checksum a journal body is stored with: SHA-256 over its canonical JSON. */
export function journalChecksum(body: RestoreJournalBody): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

function serialize(body: RestoreJournalBody): string {
  const journal: RestoreJournal = { ...body, checksum: journalChecksum(body) };
  return `${JSON.stringify(journal, null, 2)}\n`;
}

function writeSynced(path: string, text: string, flags: "wx" | "w"): void {
  const fd = openSync(path, flags);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Syncs a directory so a rename in it survives a crash; Windows cannot open directories, where NTFS journals the rename itself. */
export function syncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Not supported on this platform.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Creates the journal exclusively: it fails with `EEXIST` while another restore holds the
 * data directory or an interrupted one awaits recovery.
 */
export function createJournal(path: string, body: RestoreJournalBody): void {
  writeSynced(path, serialize(body), "wx");
  syncDirectory(dirname(path));
}

/** Replaces the journal atomically: a synced temporary file renamed over it. */
export function writeJournal(path: string, body: RestoreJournalBody): void {
  const temporary = `${path}.tmp`;
  writeSynced(temporary, serialize(body), "w");
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

/** `undefined` when there is no journal; `"damaged"` when it cannot be trusted. */
export function readJournal(path: string): RestoreJournal | "damaged" | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return "damaged";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "damaged";
  }
  const journal = restoreJournalSchema.safeParse(parsed);
  if (!journal.success) return "damaged";
  const { checksum, ...body } = journal.data;
  return journalChecksum(body) === checksum ? journal.data : "damaged";
}

/** Removes the journal and a leftover temporary file of it. */
export function removeJournal(path: string): void {
  rmSync(`${path}.tmp`, { force: true });
  rmSync(path, { force: true });
  syncDirectory(dirname(path));
}
