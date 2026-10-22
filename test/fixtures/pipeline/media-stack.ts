import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { signFileGrant } from "../../../src/server/adapters/file-grant/hmac-file-grant.ts";
import { HmacFileGrantVerifier } from "../../../src/server/adapters/file-grant/hmac-file-grant.ts";
import { FlatCacheFileStore } from "../../../src/server/adapters/file-store/flat-cache-file-store.ts";
import { LocalFileStore } from "../../../src/server/adapters/file-store/local-file-store.ts";
import { FfmpegMediaIngest } from "../../../src/server/adapters/media-ingest/ffmpeg-media-ingest.ts";
import { NodeProcessRunner } from "../../../src/server/adapters/process-runner/node-process-runner.ts";
import type { BuiltApp } from "../../../src/server/app.ts";
import { DeleteContentService } from "../../../src/server/application/delete-content.ts";
import { PendingFileDeleter } from "../../../src/server/application/pending-file-delete.ts";
import { TrashService } from "../../../src/server/application/trash.ts";
import { LocalImportService } from "../../../src/server/application/local-import.ts";
import { MediaAssetService } from "../../../src/server/application/media-assets.ts";
import { StorageQuota } from "../../../src/server/application/storage-quota.ts";
import { AssetJanitor } from "../../../src/server/pipeline/asset-janitor.ts";
import { SplitMediaFiles } from "../../../src/server/pipeline/media-files.ts";
import type { StageExecutors } from "../../../src/server/pipeline/executor.ts";
import { MediaStageExecutor } from "../../../src/server/pipeline/stages/media.ts";
import type { FileStore } from "../../../src/server/ports/file-store.ts";
import { childProcessEnv } from "../../../src/server/ports/process-runner.ts";
import type { FileGrant } from "../../../src/shared/dto/local-media.ts";
import { FILE_GRANT_TTL_MS } from "../../../src/shared/defaults.ts";
import { toolsBinDir } from "../tools.ts";
import { countingExecutor, createHarness, silentLogger, type Harness, type HarnessOptions } from "./harness.ts";

/**
 * The harness plus the real local-media stack: FileStore on the harness's temp data
 * directory, ffprobe / ffmpeg from `.amber-tools/bin`, the media stage, the janitor and
 * the import / media / deletion services. `executors` are added on top of the media stage.
 */
export interface MediaStack {
  h: Harness;
  /** The data store (`h.dir`). */
  files: FileStore;
  /** Data store plus cache store; the cache starts on the data root and tests may `cache.setRoot` elsewhere. */
  stores: SplitMediaFiles;
  ingest: FfmpegMediaIngest;
  localImport: LocalImportService;
  media: MediaAssetService;
  /** The pending-file worker over `stores`. */
  fileDeleter: PendingFileDeleter;
  deleteContent: DeleteContentService;
  trash: TrashService;
  janitor: AssetJanitor;
  grant(path: string, purpose?: FileGrant["purpose"]): FileGrant;
  app(mode: "local" | "server"): Promise<BuiltApp>;
  close(): Promise<void>;
}

export interface MediaStackOptions extends Omit<HarnessOptions, "executors"> {
  executors?: StageExecutors;
  maxUploadBytes?: number;
  /** Replaces the real FileStore, for tests that must not write the bytes they stream. */
  files?: FileStore;
}

export function createMediaStack(options: MediaStackOptions = {}): MediaStack {
  const ingest = new FfmpegMediaIngest({ runner: new NodeProcessRunner(), binDir: toolsBinDir(), env: childProcessEnv(process.env) });
  let files: FileStore | undefined = options.files;
  const executors: StageExecutors = {
    ...Object.fromEntries(["asr", "proofread", "chapter", "summary"].map((stage) => [stage, countingExecutor()])),
    ...options.executors,
  };
  const h = createHarness({ ...options, executors });
  files ??= new LocalFileStore(h.dir);
  const stores = new SplitMediaFiles(files, (dir, options) => new FlatCacheFileStore(dir, options), join(h.dir, "media"));
  const repository = h.repository;
  executors.media ??= new MediaStageExecutor({ repository, files, ingest, mode: "local" });
  const key = randomBytes(32);
  const control = { kick: () => h.scheduler.kick() };
  const localImport = new LocalImportService({
    repository,
    bus: h.bus,
    control,
    files,
    ingest,
    disk: h.disk,
    settings: h.settings,
    grants: new HmacFileGrantVerifier(key),
    quota: new StorageQuota({ repository, files }),
    newId: h.newId,
    ...(options.maxUploadBytes === undefined ? {} : { maxUploadBytes: options.maxUploadBytes }),
  });
  const media = new MediaAssetService({ repository, media: stores, gate: h.gate });
  let lateTrash: TrashService | undefined;
  const fileDeleter = new PendingFileDeleter({
    repository, media: stores, dataDir: h.dir, gate: h.gate, afterDrain: () => lateTrash?.refresh(), logger: silentLogger, newId: h.newId,
  });
  const deleteContent = new DeleteContentService({ repository, gate: h.gate, fileDeleter, chat: h.chat });
  const trashService = new TrashService({ repository, deleteContent, fileDeleter, chat: h.chat, logger: silentLogger });
  lateTrash = trashService;
  const janitor = new AssetJanitor({ repository, media: stores, bus: h.bus, logger: silentLogger, pendingRefs: () => fileDeleter.currentPendingRefs() });
  const stop = janitor.start();
  return {
    h,
    files,
    stores,
    ingest,
    localImport,
    media,
    fileDeleter,
    deleteContent,
    trash: trashService,
    janitor,
    grant: (path, purpose = "local_file") => signFileGrant(key, { path, purpose, expiresAt: Date.now() + FILE_GRANT_TTL_MS }),
    app: (mode) => h.app({ mode, localImport, media, trash: trashService }),
    async close() {
      stop();
      await trashService.stop();
      await fileDeleter.stop();
      await h.close();
      await janitor.whenIdle();
    },
  };
}

/** Where a managed file of the stack lives on disk. */
export function dataPath(stack: MediaStack, ref: string): string {
  return join(stack.h.dir, ...ref.split("/"));
}
