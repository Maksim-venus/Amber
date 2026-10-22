import { createHash } from "node:crypto";
import { once } from "node:events";
import { closeSync, createReadStream, createWriteStream, fstatSync, fsyncSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { Header, Pack, ReadEntry } from "tar";
import { BACKUP_DATABASE_ENTRY, BACKUP_HEADER_ENTRY, BACKUP_MANIFEST_ENTRY, type BackupManifest } from "../../../shared/backup.ts";
import { amberError } from "../../domain/errors.ts";
import type { BackupArchiveFile, BackupArchiveRequest, BackupArchiveResult, BackupArchiveWriter } from "../../ports/backup.ts";

/** A file that no longer matches what the header promised. */
class ChangedFile extends Error {
  readonly assetId: string;

  constructor(assetId: string) {
    super("backup source file changed");
    this.assetId = assetId;
  }
}

type Source = AsyncIterable<Buffer>;

/**
 * Adds one regular file entry and streams `source` into it, hashing as it goes. Ownership,
 * device and access times are never written (portable mode); the modification time is the
 * backup's own creation time, so no file's local timestamps leave the device.
 */
async function addEntry(pack: Pack, path: string, size: number, mtime: Date, source: Source, signal: AbortSignal, onBytes: (bytes: number) => void): Promise<{ sha256: string; sizeBytes: number }> {
  const entry = new ReadEntry(new Header({ path, size, mode: 0o644, type: "File", mtime }));
  pack.add(entry);
  const hash = createHash("sha256");
  let written = 0;
  for await (const chunk of source) {
    signal.throwIfAborted();
    written += chunk.length;
    if (written > size) {
      throw new RangeError("source longer than declared");
    }
    hash.update(chunk);
    if (!entry.write(chunk)) {
      await once(entry, "drain", { signal });
    }
    onBytes(chunk.length);
  }
  if (written !== size) {
    throw new RangeError("source shorter than declared");
  }
  entry.end();
  return { sha256: hash.digest("hex"), sizeBytes: size };
}

async function* bufferSource(buffer: Buffer): Source {
  yield buffer;
}

/** Streams one file into the archive; any mismatch with its registration, or a read failure, is a changed file. */
async function copyFile(pack: Pack, file: BackupArchiveFile, mtime: Date, signal: AbortSignal, onBytes: (bytes: number) => void): Promise<{ sha256: string; sizeBytes: number }> {
  let copied: { sha256: string; sizeBytes: number };
  try {
    const stats = statSync(file.sourcePath);
    if (!stats.isFile() || stats.size !== file.sizeBytes) {
      throw new ChangedFile(file.assetId);
    }
    copied = await addEntry(pack, file.archivePath, file.sizeBytes, mtime, createReadStream(file.sourcePath), signal, onBytes);
  } catch (error) {
    if (signal.aborted || error instanceof ChangedFile) {
      throw signal.aborted ? signal.reason : error;
    }
    throw new ChangedFile(file.assetId);
  }
  if (file.fingerprint !== undefined && file.fingerprint !== `sha256:${copied.sha256}`) {
    throw new ChangedFile(file.assetId);
  }
  return copied;
}

/**
 * The `amber-backup-v1` writer: an uncompressed tar through npm `tar`, entries
 * in the fixed order header → database → originals → cache files → manifest. The archive is
 * written to `<target>.partial`, created exclusively, synced and renamed into place only when
 * every file matched its registration; any failure removes the partial file.
 */
export class TarBackupArchiveWriter implements BackupArchiveWriter {
  async write(request: BackupArchiveRequest): Promise<BackupArchiveResult> {
    const partial = `${request.target}.partial`;
    let fd: number;
    try {
      fd = openSync(partial, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw amberError("conflict", "a partial backup already exists at the destination", { code: "conflict.backup_in_progress" });
      }
      throw error;
    }
    let open = true;
    const out = createWriteStream("", { fd, autoClose: false });
    const pack = new Pack({ portable: true });
    const finished = new Promise<void>((resolve, reject) => {
      out.on("finish", resolve);
      out.on("error", reject);
      pack.on("error", reject);
    });
    // A failure before the end leaves `finished` unawaited; its rejection is not an unhandled one.
    finished.catch(() => undefined);
    pack.pipe(out);
    try {
      const mtime = new Date(request.header.createdAt);
      const files: BackupManifest["files"] = [];
      const headerBytes = Buffer.from(JSON.stringify(request.header), "utf8");
      await addEntry(pack, BACKUP_HEADER_ENTRY, headerBytes.length, mtime, bufferSource(headerBytes), request.signal, () => undefined);

      let bytesDone = 0;
      let filesDone = 0;
      const report = (phase: "snapshot" | "originals" | "cache" | "finalize"): void => request.onProgress?.({ phase, bytesDone, filesDone });
      const databaseSize = statSync(request.databasePath).size;
      const database = await addEntry(pack, BACKUP_DATABASE_ENTRY, databaseSize, mtime, createReadStream(request.databasePath), request.signal, (bytes) => {
        bytesDone += bytes;
        report("snapshot");
      });
      files.push({ path: BACKUP_DATABASE_ENTRY, ...database });
      filesDone += 1;

      for (const file of request.files) {
        const phase = file.kind === "original" ? "originals" : "cache";
        const copied = await copyFile(pack, file, mtime, request.signal, (bytes) => {
          bytesDone += bytes;
          report(phase);
        });
        files.push({ path: file.archivePath, ...copied });
        filesDone += 1;
        report(phase);
      }

      report("finalize");
      const manifest: BackupManifest = { headerSha256: createHash("sha256").update(headerBytes).digest("hex"), files };
      const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
      await addEntry(pack, BACKUP_MANIFEST_ENTRY, manifestBytes.length, mtime, bufferSource(manifestBytes), request.signal, () => undefined);
      pack.end();
      await finished;
      fsyncSync(fd);
      const sizeBytes = fstatSync(fd).size;
      closeSync(fd);
      open = false;
      renameSync(partial, request.target);
      return { ok: true, sizeBytes };
    } catch (error) {
      if (open) {
        // Destroying a file stream closes its descriptor; nothing else may close it.
        pack.unpipe(out);
        out.on("error", () => undefined);
        await new Promise<void>((resolve) => {
          out.once("close", () => resolve());
          out.destroy();
        });
        open = false;
      }
      rmSync(partial, { force: true });
      if (error instanceof ChangedFile) {
        return { ok: false, changedAssetId: error.assetId };
      }
      throw error;
    }
  }
}
