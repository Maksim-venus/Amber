import { createHash } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, statfsSync, statSync, writeSync } from "node:fs";
import { extname } from "node:path";

/**
 * File operations of a restore: the names restored originals get, the
 * exclusive copy that never touches a file it did not create, and per-volume space checks.
 */

/** Characters Windows refuses in a file name, and C0 / C1 control characters. */
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/gu;
/** Device names Windows reserves, with or without an extension. */
const RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;

/**
 * The name an original gets in the restore directory: forbidden and control characters
 * removed, trailing dots and spaces removed, a reserved device name prefixed with `_`; a
 * name that is empty afterwards falls back to the asset id.
 */
export function safeOriginalName(originalName: string, assetId: string): string {
  let name = originalName.normalize("NFC").replace(FORBIDDEN, "").replace(/[. ]+$/u, "").trim();
  if (name === "" || name === "." || name === "..") {
    name = assetId;
  }
  const dot = name.indexOf(".");
  const base = dot === -1 ? name : name.slice(0, dot);
  if (RESERVED.test(base.trimEnd())) {
    name = `_${name}`;
  }
  return name;
}

/** `name (<last six characters of the asset id>).ext`: how a second original with the same name is told apart. */
export function disambiguatedName(name: string, assetId: string): string {
  const extension = extname(name);
  const stem = extension === "" || extension === name ? name : name.slice(0, -extension.length);
  return `${stem} (${assetId.slice(-6)})${extension}`;
}

/**
 * Assigns each original a unique name in the restore directory. Names are compared without
 * case, as Windows does; a collision gets the asset id suffix, and a collision even then a
 * further counter.
 */
export function assignOriginalNames(originals: ReadonlyArray<{ assetId: string; originalName: string }>): Map<string, string> {
  const taken = new Set<string>();
  const names = new Map<string, string>();
  for (const { assetId, originalName } of originals) {
    let name = safeOriginalName(originalName, assetId);
    if (taken.has(name.toLowerCase())) {
      name = disambiguatedName(name, assetId);
      for (let n = 2; taken.has(name.toLowerCase()); n += 1) {
        name = disambiguatedName(safeOriginalName(originalName, assetId), `${assetId.slice(-6)}-${n}`);
      }
    }
    taken.add(name.toLowerCase());
    names.set(assetId, name);
  }
  return names;
}

const COPY_CHUNK_BYTES = 1024 * 1024;

/** Thrown when a file this restore wrote is not the file found under its name afterwards. */
export class FileIdentityError extends Error {}

/**
 * Copies `from` to `to` through `<to>.partial`, created exclusively, so the copy can only ever
 * write a file of its own: the partial file must be a regular file once open, is synced and
 * renamed into place, and afterwards the name must still hold a file of the expected size and
 * inode. The file stays open until that check, so its inode cannot be reused meanwhile.
 * `beforeRename` lets tests interrupt between writing and renaming.
 */
export function copyFileExclusive(from: string, to: string, hooks: { beforeRename?: () => void } = {}): void {
  const partial = `${to}.partial`;
  const output = openSync(partial, "wx");
  try {
    const opened = fstatSync(output, { bigint: true });
    if (!opened.isFile()) {
      throw new FileIdentityError("the partial file is not a regular file");
    }
    const input = openSync(from, "r");
    try {
      const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      for (;;) {
        const read = readSync(input, buffer, 0, COPY_CHUNK_BYTES, null);
        if (read === 0) break;
        let offset = 0;
        while (offset < read) {
          offset += writeSync(output, buffer, offset, read - offset);
        }
      }
    } finally {
      closeSync(input);
    }
    fsyncSync(output);
    const written = fstatSync(output, { bigint: true });
    hooks.beforeRename?.();
    renameSync(partial, to);
    const placed = lstatSync(to, { bigint: true });
    if (!placed.isFile() || placed.dev !== written.dev || placed.ino !== written.ino || placed.size !== written.size) {
      throw new FileIdentityError("the restored file was replaced after it was written");
    }
  } finally {
    closeSync(output);
  }
}

/** SHA-256 of a file, streamed. */
export function sha256OfFile(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    for (;;) {
      const read = readSync(fd, buffer, 0, COPY_CHUNK_BYTES, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** Whether `path` names a regular file of `sizeBytes` bytes whose SHA-256 is `sha256`. */
export function hasIdentity(path: string, sizeBytes: number, sha256: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && stat.size === sizeBytes && sha256OfFile(path) === sha256;
  } catch {
    return false;
  }
}

/**
 * Whether every volume has room for what is written to it. `needs` maps an existing
 * directory on each volume to the bytes written there; directories on the same device add up.
 */
export function volumesWithoutSpace(needs: ReadonlyArray<{ dir: string; bytes: number }>): string[] {
  const byDevice = new Map<string, { dir: string; bytes: number }>();
  for (const need of needs) {
    const device = String(statSync(need.dir).dev);
    const entry = byDevice.get(device);
    if (entry === undefined) byDevice.set(device, { dir: need.dir, bytes: need.bytes });
    else entry.bytes += need.bytes;
  }
  const short: string[] = [];
  for (const { dir, bytes } of byDevice.values()) {
    const volume = statfsSync(dir);
    if (Number(volume.bavail) * Number(volume.bsize) < bytes) short.push(dir);
  }
  return short;
}
