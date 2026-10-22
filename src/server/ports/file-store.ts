/** Size and `sha256:<hex>` digest of a file written through the store. */
export interface StoredFile {
  sizeBytes: number;
  digest: string;
}

/**
 * What `writeAtomic` writes: bytes, a byte stream, or a producer that writes the partial
 * file itself (a tool such as ffmpeg given the path).
 */
export type AtomicWriteSource = Uint8Array | AsyncIterable<Uint8Array> | ((partialPath: string) => Promise<void>);

export interface WriteAtomicOptions {
  /** Streaming limit; exceeding it removes the partial file and throws `FileTooLargeError`. */
  maxBytes?: number;
  /**
   * Runs on the complete, fsynced partial file before the rename (content sniffing,
   * probing). Throwing removes the partial file and nothing is committed.
   */
  beforeCommit?: (partialPath: string, stored: StoredFile) => Promise<void>;
}

/** A write stopped at `WriteAtomicOptions.maxBytes`; the partial file is already gone. */
export class FileTooLargeError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`file exceeds ${limitBytes} bytes`);
    this.name = "FileTooLargeError";
    this.limitBytes = limitBytes;
  }
}

/**
 * Files under the data directory, addressed by refs relative to it: `assets/<userId>/
 * <contentId>/<assetId>` for media of every kind, `tmp/tasks/<taskId>/…` for Task
 * scratch files and checkpoints, `tmp/cookies/`, `tmp/backup/`. Refs never contain the
 * original filename. `external_local` files are outside its reach. Invariant: Amber never
 * deletes an `external_local` file.
 */
export interface FileStore {
  /** Absolute path of a ref, for handing to a tool; rejects refs that escape the data directory. */
  pathOf(ref: string): string;
  /**
   * Writes `<ref>.partial` next to the target, fsyncs, runs `beforeCommit`, then renames
   * atomically. Callers record the returned digest in the database only after this
   * resolves. Running out of space fails with `disk_low`.
   */
  writeAtomic(ref: string, data: AtomicWriteSource, options?: WriteAtomicOptions): Promise<StoredFile>;
  /** Streams a file, or the inclusive byte range `[start, end]` of it. */
  read(ref: string, range?: { start: number; end?: number }): AsyncIterable<Uint8Array>;
  stat(ref: string): Promise<{ sizeBytes: number } | null>;
  /** `sha256:<hex>` of the file's content, or `null` when it does not exist. */
  digest(ref: string): Promise<string | null>;
  /** Removes a file, or a directory with everything under it; a missing ref is not an error. */
  remove(ref: string): Promise<void>;
  /**
   * Removes the empty directories under `prefix` and `prefix` itself when it ends up empty,
   * deepest first; files are never touched. With `olderThan` (epoch ms), a directory changed
   * at or after it stays, so one a concurrent write has just created is left alone. Returns
   * how many directories went.
   */
  removeEmptyDirs(prefix: string, options?: { olderThan?: number }): Promise<number>;
  /** Refs of the regular files under `prefix`, recursively; empty when it does not exist. */
  list(prefix: string): Promise<string[]>;
  /**
   * Bytes of the committed regular files under `prefix`, recursively; `.partial` files of
   * writes still in progress are not counted. Zero when it does not exist.
   */
  usedBytes(prefix: string): Promise<number>;
  /** Leftover `.partial` files are debris of interrupted writes and are safe to delete before re-running. */
  removePartials(): Promise<number>;
  diskUsage(): Promise<{ usedBytes: number; freeBytes: number; totalBytes: number }>;
}
