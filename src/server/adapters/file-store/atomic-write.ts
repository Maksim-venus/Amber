import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { amberError } from "../../domain/errors.ts";
import { FileTooLargeError, type AtomicWriteSource, type StoredFile, type WriteAtomicOptions } from "../../ports/file-store.ts";

/**
 * The write and hashing primitives both file stores share: the data directory's
 * `LocalFileStore` and the flat media cache store.
 */

export const PARTIAL_SUFFIX = ".partial";

export function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function toWriteError(error: unknown): unknown {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOSPC"
    ? amberError("disk_low", "no space left while writing a file")
    : error;
}

export async function hashFile(path: string): Promise<StoredFile> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    sizeBytes += (chunk as Buffer).length;
  }
  return { sizeBytes, digest: `sha256:${hash.digest("hex")}` };
}

/** Streams into `path` while hashing, with backpressure from the file handle. */
async function writeStream(path: string, data: Uint8Array | AsyncIterable<Uint8Array>, maxBytes: number | undefined): Promise<StoredFile> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const handle = await open(path, "w");
  try {
    const chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array> = data instanceof Uint8Array ? [data] : data;
    for await (const chunk of chunks) {
      sizeBytes += chunk.length;
      if (maxBytes !== undefined && sizeBytes > maxBytes) {
        throw new FileTooLargeError(maxBytes);
      }
      hash.update(chunk);
      await handle.write(chunk);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { sizeBytes, digest: `sha256:${hash.digest("hex")}` };
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
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


/**
 * Writes `<target>.partial`, fsyncs, runs `beforeCommit`, then renames over `target` and
 * syncs the directory. The directory must exist. Any failure removes the partial file.
 */
export async function writeAtomically(target: string, data: AtomicWriteSource, options: WriteAtomicOptions = {}): Promise<StoredFile> {
  const partial = `${target}${PARTIAL_SUFFIX}`;
  try {
    let stored: StoredFile;
    if (typeof data === "function") {
      await data(partial);
      await syncFile(partial);
      stored = await hashFile(partial);
      if (options.maxBytes !== undefined && stored.sizeBytes > options.maxBytes) {
        throw new FileTooLargeError(options.maxBytes);
      }
    } else {
      stored = await writeStream(partial, data, options.maxBytes);
    }
    await options.beforeCommit?.(partial, stored);
    await rename(partial, target);
    await syncDirectory(dirname(target));
    return stored;
  } catch (error) {
    await rm(partial, { force: true });
    throw toWriteError(error);
  }
}
