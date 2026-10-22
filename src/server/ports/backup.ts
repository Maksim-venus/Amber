import type { BackupHeader, LibraryCategory } from "../../shared/backup.ts";

/** One file a backup may include, as registered in `media_asset`. */
export interface BackupMediaRow {
  assetId: string;
  contentId: string;
  kind: "external_local" | "platform_cache";
  /** `external_local`: the absolute path; `platform_cache`: `media/<file name>` in the cache directory. */
  storageRef: string;
  displayName?: string;
  sizeBytes: number;
  /** `sha256:<hex>` over the whole file when registered. */
  fingerprint?: string;
}

/** What the export keeps of the files: the asset ids actually written into the archive. */
export interface SnapshotScope {
  includedOriginals: ReadonlySet<string>;
  includedCaches: ReadonlySet<string>;
}

export interface SnapshotSummary {
  schemaVersion: number;
  contents: number;
  collections: number;
  notes: number;
}

/**
 * The database side of the client backup. The export snapshots the live
 * database with `VACUUM INTO` (never by copying WAL files) and strips the copy, so nothing
 * in the live database changes.
 */
export interface BackupStore {
  /** Writes a consistent snapshot of the live database to `path`, a file that must not exist yet. */
  snapshotTo(path: string): void;
  /**
   * Strips the snapshot at `path` in one transaction with foreign keys on, in a fixed
   * order: profiles lose their credential references; platform accounts, then every
   * remaining Secret are deleted; sessions, login credentials, idempotency records, pending
   * file deletes and the network allowlist are emptied; the instance's cache root, cache
   * move and credential-reset time and the cookie-browser preference are cleared; Task-scoped
   * assets are deleted; caches outside `scope` become `evicted`, and originals outside
   * `scope` and every upload become `missing`. It then checks `foreign_key_check`,
   * `integrity_check` and that no secret is left; any failed check throws `backup_invalid`.
   * The snapshot is closed afterwards.
   */
  stripSnapshot(path: string, scope: SnapshotScope): SnapshotSummary;
  /** The `available` originals (`external_local`) and caches (`platform_cache`) of the live database. */
  listBackupMedia(): { originals: BackupMediaRow[]; caches: BackupMediaRow[] };
  /** The live database file's size in bytes, for the estimate. */
  databaseBytes(): number;
  /** The categories a fresh install has empty that the live database already holds; restoring requires none. */
  nonEmptyCategories(): LibraryCategory[];
}

/** One file copied into the archive after the database: an original or a cache file. */
export interface BackupArchiveFile {
  kind: "original" | "cache";
  assetId: string;
  archivePath: string;
  /** Where the file is read from right now. */
  sourcePath: string;
  /** The registered size; the copy fails when the file on disk differs. */
  sizeBytes: number;
  /** `sha256:<hex>` the copied bytes must hash to, when registered (originals only). */
  fingerprint?: string;
}

export interface BackupArchiveProgress {
  phase: "snapshot" | "originals" | "cache" | "finalize";
  bytesDone: number;
  filesDone: number;
}

export interface BackupArchiveRequest {
  /** The destination the user chose; the archive is written to `<target>.partial` first and renamed at the end. */
  target: string;
  /** Serialized as the first entry; it already fixes every file the archive contains. */
  header: BackupHeader;
  /** The stripped snapshot, written as `database.sqlite`. */
  databasePath: string;
  files: readonly BackupArchiveFile[];
  signal: AbortSignal;
  onProgress?: (progress: BackupArchiveProgress) => void;
}

/**
 * `changed`: a file no longer matched its registered size or fingerprint, or could not be
 * read; the partial archive is already removed. Other failures (the destination, an abort)
 * reject and also leave no partial archive behind.
 */
export type BackupArchiveResult = { ok: true; sizeBytes: number } | { ok: false; changedAssetId: string };

/** Writes the `amber-backup-v1` archive. */
export interface BackupArchiveWriter {
  write(request: BackupArchiveRequest): Promise<BackupArchiveResult>;
}
