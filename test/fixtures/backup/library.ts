import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Parser, type ReadEntry } from "tar";
import { join } from "node:path";
import { HmacFileGrantVerifier, signFileGrant } from "../../../src/server/adapters/file-grant/hmac-file-grant.ts";
import { TarBackupArchiveWriter } from "../../../src/server/adapters/backup/archive-writer.ts";
import { SqliteBackupStore } from "../../../src/server/adapters/sqlite/backup-store.ts";
import { BackupExportService } from "../../../src/server/application/backup-export.ts";
import { NoteService } from "../../../src/server/application/notes.ts";
import type { MediaAsset } from "../../../src/server/domain/media-asset.ts";
import type { BackupArchiveWriter } from "../../../src/server/ports/backup.ts";
import { FILE_GRANT_TTL_MS } from "../../../src/shared/defaults.ts";
import type { BackupExportJobDto } from "../../../src/shared/dto/backup.ts";
import type { FileGrant } from "../../../src/shared/dto/local-media.ts";
import { tempDataDir } from "../../tools/sqlite.ts";
import { configureAsr, configureLlm, createLocalContent, createTaskOfKind, LOCAL, silentLogger, type Harness } from "../pipeline/harness.ts";
import { lectureTranscripts, type TranscriptFixture } from "../transcripts/lecture.ts";

/**
 * A small library on a harness for backup tests: one local Content with transcripts, a note,
 * an `external_local` original outside the data directory, a platform cache file, the
 * extracted audio a finished Task left behind (the janitor has not run), an LLM profile, two
 * ASR profiles and platform cookies, each with a secret. Placeholders only; nothing real.
 */
export interface BackupLibrary {
  contentId: string;
  fixture: TranscriptFixture;
  original: { assetId: string; path: string; bytes: Buffer };
  cache: { assetId: string; ref: string; bytes: Buffer };
  audio: { assetId: string; ref: string };
  collectionId: string;
}

export function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function seedLibrary(h: Harness): Promise<BackupLibrary> {
  const contentId = createLocalContent(h);
  const fixture = lectureTranscripts(contentId);
  h.repository.withTransaction((scope) => {
    for (const { revision, segments } of [fixture.platform, fixture.asr, fixture.corrected]) {
      scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
    }
    scope.contents.setMetadata(LOCAL.userId, contentId, { title: "检索增强生成" }, 2);
  });
  const first = fixture.corrected.segments[0];
  if (first === undefined) throw new Error("fixture has no segment");
  new NoteService({ repository: h.repository, newId: h.newId }).create(LOCAL, contentId, {
    transcriptRevisionId: fixture.corrected.revision.id,
    startSegmentId: first.id,
    startOffset: 0,
    endSegmentId: first.id,
    endOffset: 2,
    mark: "background",
    color: "yellow",
  });
  const collectionId = h.newId();
  h.repository.withTransaction((scope) =>
    scope.collections.insert({ id: collectionId, userId: LOCAL.userId, name: "一门课", createdAt: 1, updatedAt: 1 }),
  );

  const originalsDir = tempDataDir("amber-originals-");
  const originalBytes = randomBytes(4096);
  const originalPath = join(originalsDir, "第一讲 录像.mp4");
  writeFileSync(originalPath, originalBytes);
  const cacheBytes = randomBytes(2048);
  const cacheRef = "media/第一讲.mp4";
  await h.media.cache.writeAtomic(cacheRef, cacheBytes);

  const taskId = createTaskOfKind(h, "process_content", {}, { contentId });
  h.repository.withTransaction((scope) => scope.tasks.setProjection(LOCAL.userId, taskId, "succeeded", 2));
  const audioRef = `tmp/tasks/${taskId}/audio.mp3`;
  mkdirSync(join(h.dir, "tmp", "tasks", taskId), { recursive: true });
  writeFileSync(join(h.dir, audioRef), "audio");

  const asset = (extra: Partial<MediaAsset> & Pick<MediaAsset, "kind" | "storageRef">): MediaAsset => ({
    id: h.newId(),
    userId: LOCAL.userId,
    contentId,
    mimeType: "video/mp4",
    sizeBytes: 0,
    availability: "available",
    retentionPolicy: "keep",
    createdAt: 1,
    ...extra,
  });
  const original = asset({ kind: "external_local", storageRef: originalPath, sizeBytes: originalBytes.length, fingerprint: `sha256:${sha256Of(originalBytes)}`, displayName: "第一讲 录像.mp4" });
  const cache = asset({ kind: "platform_cache", storageRef: cacheRef, sizeBytes: cacheBytes.length, retentionPolicy: "evictable" });
  const audio = asset({ kind: "extracted_audio", storageRef: audioRef, sizeBytes: 5, taskId, retentionPolicy: "ephemeral", mimeType: "audio/mpeg" });
  h.repository.withTransaction((scope) => [original, cache, audio].forEach((item) => scope.mediaAssets.insert(item)));

  configureLlm(h);
  configureAsr(h);
  configureAsr(h, LOCAL.userId, { asDefault: false, name: "second" });
  h.platformAccounts.putCookies(LOCAL, "youtube", "amber_test_cookie=<placeholder>");
  return {
    contentId,
    fixture,
    original: { assetId: original.id, path: originalPath, bytes: originalBytes },
    cache: { assetId: cache.id, ref: cacheRef, bytes: cacheBytes },
    audio: { assetId: audio.id, ref: audioRef },
    collectionId,
  };
}

export interface ExportStack {
  service: BackupExportService;
  store: SqliteBackupStore;
  ready: { value: boolean };
  exportDir: string;
  /** A fresh destination directory outside the data directory. */
  destinationDir: string;
  /** The shell's `backup_output` grant for `path`. */
  grant(path: string, purpose?: FileGrant["purpose"], expiresAt?: number): FileGrant;
}

export function createExportStack(
  h: Harness,
  options: { writer?: BackupArchiveWriter; freeBytes?: (path: string) => number; chat?: { hasAnyInflight(): boolean } } = {},
): ExportStack {
  const key = randomBytes(32);
  const store = new SqliteBackupStore({ db: h.db, file: h.file });
  const ready = { value: true };
  const exportDir = join(h.dir, "tmp", "export");
  const service = new BackupExportService({
    repository: h.repository,
    store,
    writer: options.writer ?? new TarBackupArchiveWriter(),
    grants: new HmacFileGrantVerifier(key),
    gate: h.gate,
    cache: h.media.cache,
    chat: options.chat ?? h.chat,
    backgroundReady: () => ready.value,
    exportDir,
    version: "0.0.0-test",
    logger: silentLogger,
    newId: h.newId,
    ...(options.freeBytes === undefined ? {} : { freeBytes: options.freeBytes }),
  });
  return {
    service,
    store,
    ready,
    exportDir,
    destinationDir: tempDataDir("amber-backup-dest-"),
    grant: (path, purpose = "backup_output", expiresAt = Date.now() + FILE_GRANT_TTL_MS - 1000) => signFileGrant(key, { path, purpose, expiresAt }),
  };
}

export interface ArchiveEntry {
  path: string;
  bytes: Buffer;
}

/** Every entry of a backup archive, in order, with its content. */
export async function readArchive(file: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  await new Promise<void>((resolve, reject) => {
    const parser = new Parser({
      onReadEntry: (entry: ReadEntry) => {
        const chunks: Buffer[] = [];
        entry.on("data", (chunk: Buffer) => chunks.push(chunk));
        entry.on("end", () => entries.push({ path: entry.path, bytes: Buffer.concat(chunks) }));
      },
    });
    parser.on("end", resolve);
    parser.on("error", reject);
    parser.end(readFileSync(file));
  });
  return entries;
}

/** Polls a job until it is no longer running. */
export async function settled(stack: ExportStack, jobId: string): Promise<BackupExportJobDto> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const job = stack.service.get(jobId);
    if (job.status !== "running") return job;
    if (Date.now() > deadline) throw new Error("export did not finish in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
