import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { Parser, type ReadEntry } from "tar";
import {
  BACKUP_CACHE_DIR,
  BACKUP_DATABASE_ENTRY,
  BACKUP_HEADER_ENTRY,
  BACKUP_MANIFEST_ENTRY,
  BACKUP_ORIGINALS_DIR,
  backupHeaderSchema,
  backupManifestSchema,
  type BackupHeader,
  type BackupManifest,
} from "../../../shared/backup.ts";
import { BACKUP_HEADER_MAX_BYTES, BACKUP_MANIFEST_MAX_BYTES } from "../../../shared/defaults.ts";
import { amberError, type AmberError } from "../../domain/errors.ts";

/**
 * Reading a client backup. The archive is streamed through tar's parser one
 * chunk at a time and every entry is judged before a byte of it is written: the first entry
 * must be `header.json`, the last `manifest.json`, and everything in between a regular file
 * at a path the header lists. Nothing is ever extracted by tar itself, so link, device and
 * path-traversal entries can only be refused, never followed.
 */

/** Read size per chunk; each chunk gets its own buffer because the parser may keep slices of it. */
const CHUNK_BYTES = 1024 * 1024;

const REGULAR_FILE_TYPES = new Set(["File", "OldFile", "ContiguousFile"]);
/** Directory entries a tar writer may emit for the two archive directories; they carry no data. */
const ALLOWED_DIRECTORY_ENTRIES = new Set([`${BACKUP_ORIGINALS_DIR}/`, `${BACKUP_CACHE_DIR}/`]);

export function backupInvalid(reason: string): AmberError {
  return amberError("backup_invalid", reason);
}

interface EntrySink {
  write(chunk: Buffer): void;
  end(): void;
}

interface EntryInfo {
  path: string;
  type: string;
  size: number;
}

/**
 * Feeds the archive to the parser until it ends or `done()` says enough was read. The first
 * failure (a refused entry, a parse error, a sink error) stops the reading and is thrown.
 */
function scanArchive(archivePath: string, onEntry: (entry: EntryInfo) => EntrySink, done: () => boolean = () => false): void {
  let failure: unknown;
  const fail = (error: unknown): void => {
    failure ??= error;
  };
  const parser = new Parser({ strict: true });
  parser.on("entry", (entry: ReadEntry) => {
    if (failure !== undefined) {
      entry.resume();
      return;
    }
    let sink: EntrySink;
    try {
      sink = onEntry({ path: entry.path, type: entry.type, size: entry.size });
    } catch (error) {
      fail(error);
      entry.resume();
      return;
    }
    entry.on("data", (chunk: Buffer) => {
      if (failure !== undefined) return;
      try {
        sink.write(chunk);
      } catch (error) {
        fail(error);
      }
    });
    entry.on("end", () => {
      if (failure !== undefined) return;
      try {
        sink.end();
      } catch (error) {
        fail(error);
      }
    });
  });
  parser.on("ignoredEntry", (entry: ReadEntry) => fail(backupInvalid(`unsupported entry type ${String(entry.type)}`)));
  parser.on("warn", (code: string) => fail(backupInvalid(`archive warning ${code}`)));
  parser.on("error", (error: unknown) => fail(backupInvalid(`archive error ${error instanceof Error ? error.message : String(error)}`)));

  let fd: number;
  try {
    fd = openSync(archivePath, "r");
  } catch {
    throw backupInvalid("archive cannot be opened");
  }
  let finished = false;
  try {
    let position = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      const read = readSync(fd, buffer, 0, CHUNK_BYTES, position);
      if (read === 0) {
        finished = true;
        break;
      }
      position += read;
      parser.write(buffer.subarray(0, read));
      if (failure !== undefined || done()) break;
    }
    if (finished && failure === undefined) {
      parser.end();
    }
  } finally {
    closeSync(fd);
  }
  if (failure !== undefined) {
    throw failure;
  }
}

/** Collects a small entry in memory, refusing more than `limit` bytes. */
function bufferSink(limit: number, label: string, onEnd: (bytes: Buffer) => void): EntrySink {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    write(chunk) {
      size += chunk.length;
      if (size > limit) {
        throw backupInvalid(`${label} exceeds its size limit`);
      }
      chunks.push(Buffer.from(chunk));
    },
    end() {
      onEnd(Buffer.concat(chunks));
    },
  };
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw backupInvalid(`${label} is not valid JSON`);
  }
}

export function parseHeader(bytes: Buffer): BackupHeader {
  const parsed = backupHeaderSchema.safeParse(parseJson(bytes, BACKUP_HEADER_ENTRY));
  if (!parsed.success) {
    throw backupInvalid("header does not match the backup format");
  }
  return parsed.data;
}

function parseManifest(bytes: Buffer): BackupManifest {
  const parsed = backupManifestSchema.safeParse(parseJson(bytes, BACKUP_MANIFEST_ENTRY));
  if (!parsed.success) {
    throw backupInvalid("manifest does not match the backup format");
  }
  return parsed.data;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkHeaderEntry(entry: EntryInfo, index: number): void {
  if (index !== 0 || entry.path !== BACKUP_HEADER_ENTRY) {
    throw backupInvalid("the first entry is not the header");
  }
  if (!REGULAR_FILE_TYPES.has(entry.type)) {
    throw backupInvalid("the header is not a regular file");
  }
  if (entry.size > BACKUP_HEADER_MAX_BYTES) {
    throw backupInvalid("header exceeds its size limit");
  }
}

/** Reads only the first entry, the header; the rest of the archive is not looked at. */
export function readBackupHeader(archivePath: string): BackupHeader {
  let header: BackupHeader | undefined;
  let index = 0;
  scanArchive(
    archivePath,
    (entry) => {
      // The chunk that holds the header may hold the next entries too; they are not looked at.
      if (index > 0) {
        return { write: () => undefined, end: () => undefined };
      }
      checkHeaderEntry(entry, index);
      index += 1;
      return bufferSink(BACKUP_HEADER_MAX_BYTES, BACKUP_HEADER_ENTRY, (bytes) => {
        header = parseHeader(bytes);
      });
    },
    () => header !== undefined,
  );
  if (header === undefined) {
    throw backupInvalid("the archive has no header");
  }
  return header;
}

/** One file written into the staging directory, at its archive path. */
export interface UnpackedFile {
  sizeBytes: number;
  sha256: string;
  /** Absolute path in the staging directory. */
  path: string;
}

export interface UnpackedBackup {
  header: BackupHeader;
  /** By archive path: `database.sqlite`, `originals/…`, `media/…`. */
  files: Map<string, UnpackedFile>;
}

export interface UnpackOptions {
  /** Called after each file is written, with the bytes written so far. */
  onFile?: (done: { files: number; bytes: number }) => void;
}

/**
 * Unpacks and verifies the whole archive into `stagingDir` (which must exist and be empty):
 * entry order, paths, types and size limits while streaming; afterwards the manifest against
 * the header hash and every written file (size and SHA-256), and each original against the
 * fingerprint the header registered. Any mismatch throws `backup_invalid`.
 */
export function unpackBackup(archivePath: string, stagingDir: string, options: UnpackOptions = {}): UnpackedBackup {
  let header: BackupHeader | undefined;
  let headerSha256: string | undefined;
  let manifest: BackupManifest | undefined;
  let allowed: Set<string> | undefined;
  const files = new Map<string, UnpackedFile>();
  let index = 0;
  let bytesDone = 0;

  scanArchive(archivePath, (entry) => {
    const position = index;
    index += 1;
    if (position === 0) {
      checkHeaderEntry(entry, position);
      return bufferSink(BACKUP_HEADER_MAX_BYTES, BACKUP_HEADER_ENTRY, (bytes) => {
        header = parseHeader(bytes);
        headerSha256 = sha256Hex(bytes);
        allowed = allowedPaths(header);
      });
    }
    if (manifest !== undefined) {
      throw backupInvalid("an entry follows the manifest");
    }
    if (allowed === undefined) {
      throw backupInvalid("the header is incomplete");
    }
    if (entry.type === "Directory" && ALLOWED_DIRECTORY_ENTRIES.has(entry.path)) {
      return { write: () => undefined, end: () => undefined };
    }
    if (!REGULAR_FILE_TYPES.has(entry.type)) {
      throw backupInvalid(`entry ${entry.path} is not a regular file`);
    }
    if (entry.path === BACKUP_MANIFEST_ENTRY) {
      if (entry.size > BACKUP_MANIFEST_MAX_BYTES) {
        throw backupInvalid("manifest exceeds its size limit");
      }
      return bufferSink(BACKUP_MANIFEST_MAX_BYTES, BACKUP_MANIFEST_ENTRY, (bytes) => {
        manifest = parseManifest(bytes);
      });
    }
    if (!allowed.has(entry.path)) {
      throw backupInvalid("an entry is not listed in the header");
    }
    if (files.has(entry.path)) {
      throw backupInvalid("an entry appears twice");
    }
    return fileSink(join(stagingDir, ...entry.path.split("/")), entry.size, (written) => {
      files.set(entry.path, written);
      bytesDone += written.sizeBytes;
      options.onFile?.({ files: files.size, bytes: bytesDone });
    });
  });

  if (header === undefined || headerSha256 === undefined || allowed === undefined) {
    throw backupInvalid("the archive has no header");
  }
  if (manifest === undefined) {
    throw backupInvalid("the archive has no manifest");
  }
  verifyAgainstManifest(header, headerSha256, manifest, allowed, files);
  return { header, files };
}

function allowedPaths(header: BackupHeader): Set<string> {
  const paths = [BACKUP_DATABASE_ENTRY, ...header.originals.map((original) => original.archivePath), ...header.cache.map((cache) => cache.archivePath)];
  const allowed = new Set(paths);
  if (allowed.size !== paths.length) {
    throw backupInvalid("the header lists a path twice");
  }
  const assetIds = [...header.originals, ...header.cache].map((entry) => entry.assetId);
  if (new Set(assetIds).size !== assetIds.length) {
    throw backupInvalid("the header lists an asset twice");
  }
  // Windows compares names without case: two paths that differ only in case would collide on disk.
  if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length) {
    throw backupInvalid("the header lists paths that collide on a case-insensitive file system");
  }
  return allowed;
}

/** Streams one entry into a new file: exclusive creation, hashed and counted, synced before close. */
function fileSink(target: string, declaredSize: number, onDone: (file: UnpackedFile) => void): EntrySink {
  mkdirSync(dirname(target), { recursive: true });
  let fd: number;
  try {
    fd = openSync(target, "wx");
  } catch {
    throw backupInvalid("an entry collides with another");
  }
  const hash = createHash("sha256");
  let size = 0;
  let open = true;
  const close = (): void => {
    if (open) {
      open = false;
      closeSync(fd);
    }
  };
  return {
    write(chunk) {
      try {
        size += chunk.length;
        if (size > declaredSize) {
          throw backupInvalid("an entry is longer than declared");
        }
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          offset += writeSync(fd, chunk, offset);
        }
      } catch (error) {
        close();
        throw error;
      }
    },
    end() {
      try {
        fsyncSync(fd);
      } finally {
        close();
      }
      onDone({ sizeBytes: size, sha256: hash.digest("hex"), path: target });
    },
  };
}

function verifyAgainstManifest(
  header: BackupHeader,
  headerSha256: string,
  manifest: BackupManifest,
  allowed: ReadonlySet<string>,
  files: ReadonlyMap<string, UnpackedFile>,
): void {
  if (manifest.headerSha256 !== headerSha256) {
    throw backupInvalid("the manifest does not match the header");
  }
  const listed = new Map(manifest.files.map((file) => [file.path, file]));
  if (listed.size !== manifest.files.length) {
    throw backupInvalid("the manifest lists a path twice");
  }
  if (listed.size !== allowed.size || [...allowed].some((path) => !listed.has(path))) {
    throw backupInvalid("the manifest does not list what the header declares");
  }
  for (const path of allowed) {
    const written = files.get(path);
    const expected = listed.get(path);
    if (written === undefined || expected === undefined) {
      throw backupInvalid("a declared entry is missing");
    }
    if (written.sizeBytes !== expected.sizeBytes || written.sha256 !== expected.sha256) {
      throw backupInvalid("an entry does not match the manifest");
    }
  }
  for (const original of header.originals) {
    const written = files.get(original.archivePath) as UnpackedFile;
    if (written.sizeBytes !== original.sizeBytes) {
      throw backupInvalid("an original does not have its registered size");
    }
    if (original.fingerprint !== null && original.fingerprint !== `sha256:${written.sha256}`) {
      throw backupInvalid("an original does not match its registered fingerprint");
    }
  }
}
