import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { CACHE_DIR_NAME } from "../../../shared/app-identity.ts";
import { isValidCacheFileName } from "../../../shared/cache-file-name.ts";
import type { AtomicWriteSource, FileStore, StoredFile, WriteAtomicOptions } from "../../ports/file-store.ts";
import { hashFile, isNotFound, PARTIAL_SUFFIX, writeAtomically } from "./atomic-write.ts";

const PREFIX = `${CACHE_DIR_NAME}/`;

/**
 * The media cache directory: cache files lie flat in it under
 * readable names. The logical ref `media/<file name>` maps to `<cacheDir>/<file name>`;
 * any other ref, and any name `isValidCacheFileName` rejects, is refused, which is what
 * keeps a ref from escaping the directory. Listing, usage and partial cleanup look at the
 * top level of the directory only and never at anything above it, so a cache directory
 * picked inside a user's folder never reaches the folder's other files.
 *
 * With `createDir` (the default cache directory inside the data directory) the directory is
 * created on the first write or usage probe. A relocated cache directory on a volume that
 * may be unplugged is never recreated here: a write into a missing one fails.
 */
export class FlatCacheFileStore implements FileStore {
  private readonly dir: string;
  private readonly createDir: boolean;

  constructor(dir: string, options: { createDir?: boolean } = {}) {
    this.dir = dir;
    this.createDir = options.createDir === true;
  }

  /** The cache directory this store manages. */
  directory(): string {
    return this.dir;
  }

  pathOf(ref: string): string {
    if (ref === CACHE_DIR_NAME) {
      return this.dir;
    }
    const name = ref.startsWith(PREFIX) ? ref.slice(PREFIX.length) : undefined;
    if (name === undefined || !isValidCacheFileName(name)) {
      throw new TypeError("invalid cache ref");
    }
    return join(this.dir, name);
  }

  async writeAtomic(ref: string, data: AtomicWriteSource, options?: WriteAtomicOptions): Promise<StoredFile> {
    const target = this.pathOf(ref);
    await this.ensureDir();
    return writeAtomically(target, data, options);
  }

  read(ref: string, range?: { start: number; end?: number }): AsyncIterable<Uint8Array> {
    const path = this.pathOf(ref);
    return createReadStream(path, range === undefined ? {} : { start: range.start, ...(range.end === undefined ? {} : { end: range.end }) });
  }

  async stat(ref: string): Promise<{ sizeBytes: number } | null> {
    try {
      const stats = await stat(this.pathOf(ref));
      return stats.isFile() ? { sizeBytes: stats.size } : null;
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async digest(ref: string): Promise<string | null> {
    try {
      return (await hashFile(this.pathOf(ref))).digest;
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  /** Removes one cache file; the directory itself is never removed here. */
  async remove(ref: string): Promise<void> {
    if (ref === CACHE_DIR_NAME) {
      throw new TypeError("the cache directory itself is never removed");
    }
    await rm(this.pathOf(ref), { force: true });
  }

  /** The directory is flat: there are no subdirectories of Amber's own to prune. */
  async removeEmptyDirs(): Promise<number> {
    return 0;
  }

  /** Refs of the cache files at the top level; partial files, markers and foreign names are left out. */
  async list(prefix: string): Promise<string[]> {
    if (prefix !== CACHE_DIR_NAME) {
      return [];
    }
    return (await this.fileNames()).filter((name) => isValidCacheFileName(name)).map((name) => `${PREFIX}${name}`).sort();
  }

  /** Bytes of the committed cache files at the top level. */
  async usedBytes(prefix: string): Promise<number> {
    let total = 0;
    for (const ref of await this.list(prefix)) {
      total += (await this.stat(ref))?.sizeBytes ?? 0;
    }
    return total;
  }

  /** `.partial` files at the top level whose name a cache write could have produced. */
  async removePartials(): Promise<number> {
    let removed = 0;
    for (const name of await this.fileNames()) {
      if (name.endsWith(PARTIAL_SUFFIX) && isValidCacheFileName(name.slice(0, -PARTIAL_SUFFIX.length))) {
        await rm(join(this.dir, name), { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  /** `usedBytes` is the cache files' total; free and total space are the directory's volume. */
  async diskUsage(): Promise<{ usedBytes: number; freeBytes: number; totalBytes: number }> {
    await this.ensureDir();
    const volume = await statfs(this.dir);
    return { usedBytes: await this.usedBytes(CACHE_DIR_NAME), freeBytes: volume.bavail * volume.bsize, totalBytes: volume.blocks * volume.bsize };
  }

  private async ensureDir(): Promise<void> {
    if (this.createDir) {
      await mkdir(this.dir, { recursive: true });
    }
  }

  private async fileNames(): Promise<string[]> {
    try {
      return (await readdir(this.dir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }
  }
}
