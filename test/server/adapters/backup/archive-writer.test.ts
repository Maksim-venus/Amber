import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Parser, type ReadEntry } from "tar";
import { describe, expect, it } from "vitest";
import { TarBackupArchiveWriter } from "../../../../src/server/adapters/backup/archive-writer.ts";
import { isAmberError } from "../../../../src/server/domain/errors.ts";
import type { BackupArchiveFile } from "../../../../src/server/ports/backup.ts";
import { type BackupHeader, backupManifestSchema } from "../../../../src/shared/backup.ts";
import { tempDataDir } from "../../../tools/sqlite.ts";

const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

interface Entry {
  path: string;
  bytes: Buffer;
  uid: number | undefined;
  uname: string | undefined;
  mtime: Date | undefined;
  type: string;
}

/** Every entry of an archive, in order, with its content. */
async function readArchive(file: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  await new Promise<void>((resolve, reject) => {
    const parser = new Parser({
      onReadEntry: (entry: ReadEntry) => {
        const chunks: Buffer[] = [];
        entry.on("data", (chunk: Buffer) => chunks.push(chunk));
        entry.on("end", () =>
          entries.push({ path: entry.path, bytes: Buffer.concat(chunks), uid: entry.uid, uname: entry.uname, mtime: entry.mtime, type: entry.type }),
        );
      },
    });
    parser.on("end", resolve);
    parser.on("error", reject);
    parser.end(readFileSync(file));
  });
  return entries;
}

function setup() {
  const dir = tempDataDir("amber-archive-");
  const database = randomBytes(10_000);
  const databasePath = join(dir, "database.sqlite");
  writeFileSync(databasePath, database);
  const original = randomBytes(3 * 1024 * 1024 + 17);
  const originalPath = join(dir, "第一讲.mp4");
  writeFileSync(originalPath, original);
  const cache = randomBytes(700);
  const cachePath = join(dir, "cache.mp4");
  writeFileSync(cachePath, cache);
  const files: BackupArchiveFile[] = [
    { kind: "original", assetId: "01ORIGINAL", archivePath: "originals/01ORIGINAL.mp4", sourcePath: originalPath, sizeBytes: original.length, fingerprint: `sha256:${sha(original)}` },
    { kind: "cache", assetId: "01CACHE", archivePath: "media/第一讲 缓存.mp4", sourcePath: cachePath, sizeBytes: cache.length },
  ];
  const header = { formatVersion: 1, mode: "local", createdAt: 1_800_000_000_000 } as unknown as BackupHeader;
  return { dir, database, databasePath, original, originalPath, cache, cachePath, files, header, target: join(dir, "out.amberbackup") };
}

describe("TarBackupArchiveWriter", () => {
  it("writes header, database, originals, cache files and manifest in order, with hashes that match", async () => {
    const s = setup();
    const progress: string[] = [];
    const result = await new TarBackupArchiveWriter().write({
      target: s.target,
      header: s.header,
      databasePath: s.databasePath,
      files: s.files,
      signal: new AbortController().signal,
      onProgress: (p) => progress.push(p.phase),
    });
    expect(result).toEqual({ ok: true, sizeBytes: readFileSync(s.target).length });
    expect(existsSync(`${s.target}.partial`)).toBe(false);

    const entries = await readArchive(s.target);
    expect(entries.map((entry) => entry.path)).toEqual(["header.json", "database.sqlite", "originals/01ORIGINAL.mp4", "media/第一讲 缓存.mp4", "manifest.json"]);
    expect(entries.every((entry) => entry.type === "File")).toBe(true);
    // Portable: no owner names or ids; the backup's own time instead of each file's.
    expect(entries.every((entry) => !entry.uname && !entry.uid)).toBe(true);
    expect(entries.every((entry) => entry.mtime?.getTime() === 1_800_000_000_000)).toBe(true);
    const [header, database, original, cache, manifestEntry] = entries as [Entry, Entry, Entry, Entry, Entry];
    expect(JSON.parse(header.bytes.toString("utf8"))).toEqual(s.header);
    expect(database.bytes.equals(s.database)).toBe(true);
    expect(original.bytes.equals(s.original)).toBe(true);
    expect(cache.bytes.equals(s.cache)).toBe(true);
    const manifest = backupManifestSchema.parse(JSON.parse(manifestEntry.bytes.toString("utf8")));
    expect(manifest.headerSha256).toBe(sha(header.bytes));
    expect(manifest.files).toEqual([
      { path: "database.sqlite", sizeBytes: s.database.length, sha256: sha(s.database) },
      { path: "originals/01ORIGINAL.mp4", sizeBytes: s.original.length, sha256: sha(s.original) },
      { path: "media/第一讲 缓存.mp4", sizeBytes: s.cache.length, sha256: sha(s.cache) },
    ]);
    expect(progress).toContain("originals");
    expect(progress).toContain("cache");
    expect(progress.at(-1)).toBe("finalize");
  });

  it.each([
    ["an original whose content no longer matches its fingerprint", (s: ReturnType<typeof setup>) => writeFileSync(s.originalPath, randomBytes(s.original.length)), "01ORIGINAL"],
    ["an original whose size changed", (s: ReturnType<typeof setup>) => writeFileSync(s.originalPath, Buffer.concat([s.original, Buffer.from("x")])), "01ORIGINAL"],
    ["a cache file that disappeared", (s: ReturnType<typeof setup>) => writeFileSync(s.cachePath, Buffer.alloc(0)), "01CACHE"],
  ])("reports %s as changed and leaves no archive", async (_name, change, assetId) => {
    const s = setup();
    change(s);
    const result = await new TarBackupArchiveWriter().write({ target: s.target, header: s.header, databasePath: s.databasePath, files: s.files, signal: new AbortController().signal });
    expect(result).toEqual({ ok: false, changedAssetId: assetId });
    expect(existsSync(s.target)).toBe(false);
    expect(existsSync(`${s.target}.partial`)).toBe(false);
  });

  it("reports an unreadable source as changed", async () => {
    const s = setup();
    const files = [{ ...s.files[0], sourcePath: join(s.dir, "gone.mp4") } as BackupArchiveFile];
    const result = await new TarBackupArchiveWriter().write({ target: s.target, header: s.header, databasePath: s.databasePath, files, signal: new AbortController().signal });
    expect(result).toEqual({ ok: false, changedAssetId: "01ORIGINAL" });
  });

  it("refuses a destination whose partial file already exists, and leaves that file alone", async () => {
    const s = setup();
    writeFileSync(`${s.target}.partial`, "someone else's");
    try {
      await new TarBackupArchiveWriter().write({ target: s.target, header: s.header, databasePath: s.databasePath, files: s.files, signal: new AbortController().signal });
      expect.unreachable();
    } catch (error) {
      expect(isAmberError(error) && error.appError.code).toBe("conflict.backup_in_progress");
    }
    expect(readFileSync(`${s.target}.partial`, "utf8")).toBe("someone else's");
  });

  it("stops on abort and removes the partial archive", async () => {
    const s = setup();
    const controller = new AbortController();
    const writing = new TarBackupArchiveWriter().write({
      target: s.target,
      header: s.header,
      databasePath: s.databasePath,
      files: s.files,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === "originals") controller.abort();
      },
    });
    await expect(writing).rejects.toBeDefined();
    expect(existsSync(s.target)).toBe(false);
    expect(existsSync(`${s.target}.partial`)).toBe(false);
  });
});
