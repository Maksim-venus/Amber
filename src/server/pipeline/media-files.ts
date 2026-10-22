import { mkdir, readdir, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { CACHE_SCRATCH_DIR } from "../../shared/app-identity.ts";
import type { MediaAssetKind } from "../../shared/enums.ts";
import { amberError } from "../domain/errors.ts";
import type { AtomicWriteSource, FileStore, StoredFile, WriteAtomicOptions } from "../ports/file-store.ts";

/**
 * The two stores media may live in: the data directory (`assets/…`) for every
 * kind but one, and the flat media cache directory for `platform_cache`, always, whether it
 * is the default `<data dir>/media` or a directory the desktop user picked on another
 * volume. Every read, write or removal of an asset goes through `storeFor(asset.kind)`.
 */
export interface MediaFiles {
  readonly data: FileStore;
  readonly cache: CacheFileStore;
  storeFor(kind: MediaAssetKind): FileStore;
  /** True when the user moved the cache directory away from its default. */
  hasCustomRoot(): boolean;
}

/**
 * Builds the flat cache store over an absolute cache directory; the composition passes the
 * adapter's constructor. `createDir` is set only for the default directory.
 */
export type FileStoreFactory = (dir: string, options?: { createDir?: boolean }) => FileStore;

/** A scratch directory name: an asset id, so it can never climb out of `.amber-tmp`. */
const SCRATCH_ID = /^[0-9A-Za-z]+$/u;
/**
 * `rm` retries on Windows sharing errors: a cancelled yt-dlp or ffmpeg can hold its files a
 * moment after it was killed.
 */
const SCRATCH_RM_RETRIES = 5;
/** Attempts at creating a scratch directory whose parent a finishing download may remove meanwhile. */
const SCRATCH_MKDIR_ATTEMPTS = 3;

/** One download's scratch directory inside the cache directory. */
export interface CacheScratch {
  readonly path: string;
  /** Removes the directory, and `.amber-tmp` once no other download uses it. */
  close(): Promise<void>;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function cacheUnavailable(): never {
  throw amberError("conflict", "the video cache root is not available", { code: "conflict.cache_unavailable" });
}

/**
 * The cache store: a flat store over the default cache directory `<data dir>/media`, or
 * over the custom one. A custom directory is a user-chosen `media` directory on a volume
 * that may be unplugged: writes first check that it exists and refuse with
 * `conflict.cache_unavailable` rather than recreate it (a directory Amber created on its
 * own would silently land on whatever is mounted at that path now).
 */
export class CacheFileStore implements FileStore {
  private readonly factory: FileStoreFactory;
  private readonly defaultDir: string;
  private customRoot: string | undefined;
  private store: FileStore;
  private availableFlag = true;

  constructor(factory: FileStoreFactory, defaultDir: string) {
    this.factory = factory;
    this.defaultDir = defaultDir;
    this.store = factory(defaultDir, { createDir: true });
  }

  /** Points the cache at the custom directory `root`; `undefined` is the default directory. */
  setRoot(root: string | undefined): void {
    this.customRoot = root;
    this.store = root === undefined ? this.factory(this.defaultDir, { createDir: true }) : this.factory(root);
    this.availableFlag = true;
  }

  /** The custom cache directory, or `undefined` for the default one. */
  root(): string | undefined {
    return this.customRoot;
  }

  /** The default cache directory, `<data dir>/media`, whichever directory is in use. */
  defaultDirectory(): string {
    return this.defaultDir;
  }

  /** The cache directory in use: the custom one, else the default. */
  directory(): string {
    return this.customRoot ?? this.defaultDir;
  }

  /** Whether the root exists as a directory right now; the data directory always does. */
  async isAvailable(): Promise<boolean> {
    if (this.customRoot === undefined) {
      this.availableFlag = true;
      return true;
    }
    try {
      this.availableFlag = (await stat(this.customRoot)).isDirectory();
    } catch {
      this.availableFlag = false;
    }
    return this.availableFlag;
  }

  /**
   * The last answer of `isAvailable()`, for synchronous callers (the Content read path).
   * It is as stale as the last probe: the cache root service refreshes it on every status
   * read and at start-up, and every write re-probes, so a volume that disappeared is seen
   * at the latest when something next touches the cache.
   */
  isAvailableSync(): boolean {
    return this.availableFlag;
  }

  pathOf(ref: string): string {
    return this.store.pathOf(ref);
  }

  async writeAtomic(ref: string, data: AtomicWriteSource, options?: WriteAtomicOptions): Promise<StoredFile> {
    if (this.customRoot !== undefined && !(await this.isAvailable())) {
      cacheUnavailable();
    }
    return this.store.writeAtomic(ref, data, options);
  }

  read(ref: string, range?: { start: number; end?: number }): AsyncIterable<Uint8Array> {
    return this.store.read(ref, range);
  }

  stat(ref: string): Promise<{ sizeBytes: number } | null> {
    return this.store.stat(ref);
  }

  digest(ref: string): Promise<string | null> {
    return this.store.digest(ref);
  }

  remove(ref: string): Promise<void> {
    return this.store.remove(ref);
  }

  removeEmptyDirs(prefix: string, options?: { olderThan?: number }): Promise<number> {
    return this.store.removeEmptyDirs(prefix, options);
  }

  list(prefix: string): Promise<string[]> {
    return this.store.list(prefix);
  }

  usedBytes(prefix: string): Promise<number> {
    return this.store.usedBytes(prefix);
  }

  removePartials(): Promise<number> {
    return this.store.removePartials();
  }

  diskUsage(): ReturnType<FileStore["diskUsage"]> {
    return this.store.diskUsage();
  }

  /**
   * `<cache dir>/.amber-tmp/<id>/`, empty, for the intermediate files of one download that
   * must land on the cache directory's volume. A custom directory that is not
   * mounted refuses with `conflict.cache_unavailable`, as a write would.
   */
  async openScratch(id: string): Promise<CacheScratch> {
    if (!SCRATCH_ID.test(id)) {
      throw new TypeError("invalid scratch id");
    }
    if (this.customRoot !== undefined && !(await this.isAvailable())) {
      cacheUnavailable();
    }
    const parent = join(this.directory(), CACHE_SCRATCH_DIR);
    const path = join(parent, id);
    await rm(path, { recursive: true, force: true, maxRetries: SCRATCH_RM_RETRIES });
    for (let attempt = 1; ; attempt += 1) {
      try {
        await mkdir(path, { recursive: true, mode: 0o700 });
        break;
      } catch (error) {
        // Another download closing its scratch removed the empty parent between the two levels.
        if (errorCode(error) !== "ENOENT" || attempt >= SCRATCH_MKDIR_ATTEMPTS) {
          throw error;
        }
      }
    }
    return {
      path,
      close: async () => {
        await rm(path, { recursive: true, force: true, maxRetries: SCRATCH_RM_RETRIES });
        try {
          await rmdir(parent);
        } catch (error) {
          // Still in use by another download, or already gone.
          if (errorCode(error) !== "ENOTEMPTY" && errorCode(error) !== "EEXIST" && errorCode(error) !== "ENOENT") {
            throw error;
          }
        }
      },
    };
  }

  /**
   * Start-up: removes `.amber-tmp` with whatever an interrupted download left in it and
   * returns how many entries it held. Callers check `isAvailable()` first.
   */
  async removeScratch(): Promise<number> {
    const parent = join(this.directory(), CACHE_SCRATCH_DIR);
    let entries: string[];
    try {
      entries = await readdir(parent);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return 0;
      }
      throw error;
    }
    await rm(parent, { recursive: true, force: true, maxRetries: SCRATCH_RM_RETRIES });
    return entries.length;
  }
}

/** The composition's `MediaFiles`: the data store plus the cache store over `defaultCacheDir` until moved. */
export class SplitMediaFiles implements MediaFiles {
  readonly data: FileStore;
  readonly cache: CacheFileStore;

  constructor(data: FileStore, cacheFactory: FileStoreFactory, defaultCacheDir: string) {
    this.data = data;
    this.cache = new CacheFileStore(cacheFactory, defaultCacheDir);
  }

  /** `platform_cache` always lives in the cache store, everything else in the data store. */
  storeFor(kind: MediaAssetKind): FileStore {
    return kind === "platform_cache" ? this.cache : this.data;
  }

  hasCustomRoot(): boolean {
    return this.cache.root() !== undefined;
  }
}
