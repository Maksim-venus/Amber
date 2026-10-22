import Database from "better-sqlite3";
import type { BackupHeader, LibraryCategory } from "../../../shared/backup.ts";
import { amberError } from "../../domain/errors.ts";
import type { SqliteConnection } from "./database.ts";
import { nonEmptyCategories } from "./library-state.ts";
import { latestSchemaVersion, migrate, schemaVersionUnsupported } from "./migrations.ts";

/**
 * The database side of the offline restore: the live database of the target,
 * probed and closed before it is moved aside, and the staged database from the archive,
 * checked and rewritten in place before it becomes `amber.db`.
 */

const CANONICAL_MARKER = /\[\[seg:([^\]\s]+)\]\]/gu;

/**
 * Bodies whose `[[seg:]]` markers must all resolve: a Content's summaries and their rollup
 * partials and its chat answers cite only that Content's segments, which share its lifetime.
 * Collection summaries are left out: purging one member Content legitimately leaves their
 * markers to it unresolved.
 */
const CITING_BODIES = [
  "SELECT body AS text FROM summary_revision",
  "SELECT body AS text FROM rollup_partial WHERE summary_revision_id IS NOT NULL",
  "SELECT text FROM chat_message",
] as const;

/** Rows a stripped backup never carries; finding any means the archive was not made by an export. */
const MUST_BE_EMPTY = [
  "secret",
  "session",
  "user_credential",
  "platform_account",
  "idempotency_record",
  "pending_file_delete",
  "network_allowlist",
] as const;

function invalid(reason: string): Error {
  return amberError("backup_invalid", reason);
}

/** The target's live database, opened to prove nobody else writes to it and to check it is a fresh install. */
export class LiveDatabase {
  private readonly db: SqliteConnection;

  private constructor(db: SqliteConnection) {
    this.db = db;
  }

  /**
   * Opens `file` and takes and releases a write transaction without waiting: a busy database
   * means another process (a sidecar still running) writes to it.
   */
  static open(file: string): LiveDatabase {
    const db: SqliteConnection = new Database(file, { fileMustExist: true, timeout: 0 });
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec("ROLLBACK");
    } catch (error) {
      db.close();
      if ((error as { code?: string }).code?.startsWith("SQLITE_BUSY") === true) {
        throw amberError("conflict", "another process writes to the database");
      }
      throw error;
    }
    return new LiveDatabase(db);
  }

  nonEmptyCategories(): LibraryCategory[] {
    return nonEmptyCategories(this.db);
  }

  /** Folds the WAL into the main file and closes, so the database is one file when it is moved aside. */
  close(): void {
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      this.db.close();
    }
  }

  /** Closes without touching the file further. */
  abandon(): void {
    this.db.close();
  }
}

export interface RestoredCounts {
  contents: number;
  collections: number;
  notes: number;
  missingOriginals: number;
  profilesNeedingCredentials: number;
}

/** The database unpacked from an archive, in the staging directory. */
export class StagedDatabase {
  private readonly db: SqliteConnection;
  private closed = false;

  private constructor(db: SqliteConnection) {
    this.db = db;
  }

  static open(file: string): StagedDatabase {
    let db: SqliteConnection;
    try {
      db = new Database(file, { fileMustExist: true });
      db.pragma("foreign_keys = ON");
      // Reading anything proves the file is a database at all.
      db.pragma("user_version", { simple: true });
    } catch {
      throw invalid("the archived database cannot be opened");
    }
    return new StagedDatabase(db);
  }

  /**
   * The schema must be the one the header names; a newer one than this build knows is
   * refused, an older one is migrated here, in staging, with the regular migrations.
   */
  upgradeSchema(header: BackupHeader): void {
    const found = this.db.pragma("user_version", { simple: true }) as number;
    if (found !== header.schemaVersion) {
      throw invalid("the archived database does not have the schema version the header names");
    }
    const latest = latestSchemaVersion();
    if (found > latest) {
      throw schemaVersionUnsupported(found, latest);
    }
    if (found < latest) {
      migrate(this.db);
    }
  }

  /** Integrity, foreign keys, the rows an export strips, and the segment markers that must resolve. */
  verify(): void {
    const integrity = this.db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") {
      throw invalid("the archived database fails its integrity check");
    }
    if ((this.db.pragma("foreign_key_check") as unknown[]).length > 0) {
      throw invalid("the archived database fails its foreign key check");
    }
    for (const table of MUST_BE_EMPTY) {
      if (this.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined) {
        throw invalid(`the archived database still holds ${table} rows`);
      }
    }
    if (this.db.prepare("SELECT 1 FROM instance_settings WHERE cache_root IS NOT NULL LIMIT 1").get() !== undefined) {
      throw invalid("the archived database still names a cache directory");
    }
    if (this.unresolvedMarkers() > 0) {
      throw invalid("the archived database has segment markers that do not resolve");
    }
  }

  /** Markers in the citing bodies whose segment does not exist. */
  unresolvedMarkers(): number {
    const segment = this.db.prepare("SELECT 1 FROM transcript_segment WHERE id = ?");
    let unresolved = 0;
    for (const sql of CITING_BODIES) {
      for (const row of this.db.prepare(sql).all() as Array<{ text: string }>) {
        for (const match of row.text.matchAll(CANONICAL_MARKER)) {
          if (segment.get(match[1]) === undefined) unresolved += 1;
        }
      }
    }
    return unresolved;
  }

  /**
   * Every file the header lists must belong to a row of the right kind: originals to
   * `external_local` rows, caches to `available` `platform_cache` rows stored under the
   * archive path's name.
   */
  checkMedia(header: BackupHeader): void {
    const row = this.db.prepare("SELECT kind, storage_ref, availability FROM media_asset WHERE id = ?");
    for (const original of header.originals) {
      const found = row.get(original.assetId) as { kind: string } | undefined;
      if (found?.kind !== "external_local") {
        throw invalid("an archived original has no matching media asset");
      }
    }
    for (const cache of header.cache) {
      const found = row.get(cache.assetId) as { kind: string; storage_ref: string; availability: string } | undefined;
      if (found?.kind !== "platform_cache" || found.storage_ref !== cache.archivePath || found.availability !== "available") {
        throw invalid("an archived cache file has no matching media asset");
      }
    }
  }

  /** Points each restored original at its new file and marks it available, in one transaction. */
  relocateOriginals(paths: ReadonlyMap<string, string>): void {
    const update = this.db.prepare("UPDATE media_asset SET storage_ref = ?, availability = 'available' WHERE id = ? AND kind = 'external_local'");
    this.db.transaction(() => {
      for (const [assetId, path] of paths) {
        if (update.run(path, assetId).changes !== 1) {
          throw invalid("an archived original has no matching media asset");
        }
      }
    })();
  }

  counts(): RestoredCounts {
    const count = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      contents: count("SELECT count(*) AS n FROM content"),
      collections: count("SELECT count(*) AS n FROM collection"),
      notes: count("SELECT count(*) AS n FROM note"),
      missingOriginals: count("SELECT count(*) AS n FROM media_asset WHERE kind = 'external_local' AND availability = 'missing'"),
      profilesNeedingCredentials: count("SELECT (SELECT count(*) FROM provider_profile) + (SELECT count(*) FROM asr_provider_profile) AS n"),
    };
  }

  /** Folds any WAL into the file and closes it, so the staged database is one file when renamed. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      this.db.close();
    }
  }
}
