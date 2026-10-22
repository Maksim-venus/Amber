import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/** UTF-16LE byte order mark, which NSIS `FileReadUTF16LE` expects at the start of the file. */
const BOM = 0xfeff;

const TEMP_SUFFIX = ".tmp";

/** The file's bytes: BOM, then one path per line, each ended by CRLF, all UTF-16LE. */
export function serializeCacheRoots(paths: readonly string[]): Buffer {
  return Buffer.from(`${String.fromCharCode(BOM)}${paths.map((path) => `${path}\r\n`).join("")}`, "utf16le");
}

/**
 * The paths in a registry file. A file without the byte order mark is not one Amber wrote
 * and is refused rather than read as empty: a later write would otherwise drop every root
 * the uninstaller still has to find.
 */
export function parseCacheRoots(bytes: Buffer): string[] {
  if (bytes.length < 2 || bytes.readUInt16LE(0) !== BOM || bytes.length % 2 !== 0) {
    throw new Error("unrecognised cache roots registry");
  }
  return bytes
    .subarray(2)
    .toString("utf16le")
    .split(/\r?\n/u)
    .filter((line) => line !== "");
}

/**
 * `<data dir>/cache-roots.txt`: every relocated cache directory that may
 * still carry the ownership marker, for the full uninstall to find directories outside the
 * data directory, including ones on a volume that is offline right now. It is not a mirror
 * of the current cache root: a directory is added before its marker is written and removed
 * only after its marker is gone, so a crash in between leaves at worst a stale line, never
 * a marked directory nobody lists. Writes replace the file atomically (temp file, fsync,
 * rename); calls are serialized so two updates never race on the temp file.
 */
export class CacheRootsRegistry {
  private readonly file: string;
  private readonly isWindows: boolean;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(file: string, options: { isWindows?: boolean } = {}) {
    this.file = file;
    this.isWindows = options.isWindows ?? process.platform === "win32";
  }

  /** The registered directories; none when the file does not exist yet. */
  list(): Promise<string[]> {
    return this.serialized(() => this.read());
  }

  /** Registers `path`; a path already listed (case-insensitively on Windows) is not added twice. */
  add(path: string): Promise<void> {
    return this.serialized(async () => {
      const paths = await this.read();
      if (!paths.some((listed) => this.samePath(listed, path))) {
        await this.write([...paths, path]);
      }
    });
  }

  /** Unregisters `path`; a path not listed leaves the file untouched. */
  remove(path: string): Promise<void> {
    return this.serialized(async () => {
      const paths = await this.read();
      const kept = paths.filter((listed) => !this.samePath(listed, path));
      if (kept.length !== paths.length) {
        await this.write(kept);
      }
    });
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<string[]> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    return parseCacheRoots(bytes);
  }

  private async write(paths: readonly string[]): Promise<void> {
    const temp = `${this.file}${TEMP_SUFFIX}`;
    try {
      const handle = await open(temp, "w");
      try {
        await handle.writeFile(serializeCacheRoots(paths));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.file);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    await syncDirectory(dirname(this.file));
  }

  private samePath(a: string, b: string): boolean {
    return this.isWindows ? a.toLowerCase() === b.toLowerCase() : a === b;
  }
}

/** Makes the rename durable; Windows cannot open a directory for syncing and has no need to. */
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
