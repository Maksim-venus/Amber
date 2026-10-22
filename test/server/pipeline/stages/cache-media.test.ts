import { existsSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalFileStore } from "../../../../src/server/adapters/file-store/local-file-store.ts";
import { amberError } from "../../../../src/server/domain/errors.ts";
import type { MediaAsset } from "../../../../src/server/domain/media-asset.ts";
import type { StageRun } from "../../../../src/server/domain/task.ts";
import { latestAttempts } from "../../../../src/server/pipeline/projection.ts";
import { toStageRunDto } from "../../../../src/server/pipeline/task-dto.ts";
import { CacheMediaStageExecutor, sniffMime } from "../../../../src/server/pipeline/stages/cache-media.ts";
import type { FileStore } from "../../../../src/server/ports/file-store.ts";
import type { LocalMediaIngest } from "../../../../src/server/ports/local-media-ingest.ts";
import type { PlatformSourceAdapter } from "../../../../src/server/ports/platform-source.ts";
import { CACHE_AUDIO_MP3_KBPS, CACHE_MEDIA_MAX_GB } from "../../../../src/shared/defaults.ts";
import { BYTES_PER_GB } from "../../../../src/shared/units.ts";
import { createTaskOfKind, LOCAL, stageRunsOf, taskOf, waitFor } from "../../../fixtures/pipeline/harness.ts";
import { createMediaStack, type MediaStack } from "../../../fixtures/pipeline/media-stack.ts";
import { tempDataDir } from "../../../tools/sqlite.ts";

const open: MediaStack[] = [];
afterEach(async () => {
  for (const stack of open.splice(0)) await stack.close();
});

/** An MP4-looking body: `ftyp` at offset 4. */
const MP4_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(20, 1)]);
/** An MP3-looking body: an ID3v2 header. */
const MP3_BYTES = Buffer.concat([Buffer.from("ID3"), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(30, 2)]);
const GB = BYTES_PER_GB;

type FetchVideo = NonNullable<PlatformSourceAdapter["fetchVideo"]>;
type InspectVideo = NonNullable<PlatformSourceAdapter["inspectVideo"]>;
type Usage = { usedBytes: number; freeBytes: number; totalBytes: number };
/** A volume far above any low-water mark, for tests that are not about the disk budget. */
const AMPLE_USAGE: Usage = { usedBytes: 0, freeBytes: 1000 * BYTES_PER_GB, totalBytes: 2000 * BYTES_PER_GB };

/** A store whose volume reports `usage()` and that otherwise is `store`. */
function withUsage<T extends FileStore>(store: T, usage: () => Usage): T {
  return Object.assign(Object.create(store) as T, { diskUsage: async () => usage() });
}

interface SetupOptions {
  maxBytes?: number;
  durationMs?: number;
  sameVolume?: boolean;
  dataUsage?: Usage;
  cacheUsage?: Usage;
}

function setup(options: SetupOptions = {}) {
  let stack: MediaStack | undefined;
  const evictCalls: Array<[string, string]> = [];
  const transcodes: Array<{ input: string; output: string; bitrateKbps: number }> = [];
  const ingest: Pick<LocalMediaIngest, "transcodeAudio"> = {
    async transcodeAudio(input, output, opts, onProgress) {
      transcodes.push({ input: input.path, output: output.path, bitrateKbps: opts.bitrateKbps });
      // The downloaded track is still there while it is transcoded.
      expect(existsSync(input.path)).toBe(true);
      onProgress(0.5);
      await writeFile(output.path, MP3_BYTES);
      onProgress(1);
      return { sizeBytes: MP3_BYTES.length };
    },
  };
  const executor = new CacheMediaStageExecutor({
    get repository() {
      return (stack as MediaStack).h.repository;
    },
    get media() {
      const stores = (stack as MediaStack).stores;
      // Volumes are always simulated: the real machine's free space must not decide a test.
      return {
        data: withUsage(stores.data, () => options.dataUsage ?? AMPLE_USAGE),
        cache: withUsage(stores.cache, () => options.cacheUsage ?? AMPLE_USAGE),
      };
    },
    get platforms() {
      return (stack as MediaStack).h.platformAccess;
    },
    get settings() {
      return (stack as MediaStack).h.settings;
    },
    ingest,
    sameVolume: () => options.sameVolume ?? true,
    pendingCacheRefs: () => (stack as MediaStack).fileDeleter.pendingCacheRefs(),
    evict: async (owner, keep) => {
      evictCalls.push([owner, keep]);
      return ["evicted-elsewhere"];
    },
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
  stack = createMediaStack({ executors: { cache_media: executor } });
  open.push(stack);
  const contentId = stack.h.newId();
  stack.h.repository.withTransaction((scope) =>
    scope.contents.insert({
      id: contentId,
      userId: LOCAL.userId,
      source: { kind: "bilibili", sourceUrl: "https://www.bilibili.com/video/BV1cache", platformContentId: "BV1cache", platformPartId: "cid-1" },
      ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
      processingStatus: "succeeded",
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  const adapter = stack.h.platforms.bilibili;
  const calls: Array<{ method: string; maxHeight?: number; maxBytes?: number }> = [];
  const fetchWith = (impl: FetchVideo) => {
    const fetchVideo: FetchVideo = async (ref, auth, opts, onProgress, signal) => {
      calls.push({ method: "fetchVideo", maxHeight: opts.maxHeight, maxBytes: opts.maxBytes });
      return impl(ref, auth, opts, onProgress, signal);
    };
    Object.assign(adapter, { fetchVideo });
  };
  const inspectWith = (impl: InspectVideo) => {
    const inspectVideo: InspectVideo = async (ref, auth, opts, signal) => {
      calls.push({ method: "inspectVideo", maxHeight: opts.maxHeight });
      return impl(ref, auth, opts, signal);
    };
    Object.assign(adapter, { inspectVideo });
  };
  const audioWith = (announced: number | undefined, body = Buffer.from("raw audio track")) => {
    Object.assign(adapter, {
      inspectAudio: async () => {
        calls.push({ method: "inspectAudio" });
        return announced === undefined ? {} : { sizeBytes: announced };
      },
      fetchAudio: async (_ref: unknown, _auth: unknown, output: { path: string }, onProgress: (progress: number) => void, _signal: AbortSignal, opts?: { maxBytes?: number }) => {
        calls.push({ method: "fetchAudio", ...(opts?.maxBytes === undefined ? {} : { maxBytes: opts.maxBytes }) });
        onProgress(0.5);
        await writeFile(output.path, body);
        onProgress(1);
        return { sizeBytes: body.length };
      },
    });
  };
  return { stack, contentId, evictCalls, calls, transcodes, fetchWith, inspectWith, audioWith };
}

function cacheRequest(fields: Record<string, unknown>) {
  return { requestSchemaVersion: 2, type: "video", fileName: "第 1 讲", assetId: "01CACHEASSET0000000000000A", ...fields };
}

async function runCache(stack: MediaStack, contentId: string, request: Record<string, unknown>): Promise<string> {
  const taskId = createTaskOfKind(stack.h, "cache_media", request, { contentId });
  stack.h.scheduler.start();
  stack.h.scheduler.kick();
  await waitFor(() => ["succeeded", "failed"].includes(taskOf(stack.h, taskId).statusProjection));
  return taskId;
}

const cachesOf = (stack: MediaStack, contentId: string): MediaAsset[] =>
  stack.h.repository.withTransaction((scope) => scope.mediaAssets.listByContent(LOCAL.userId, contentId)).filter((asset) => asset.kind === "platform_cache");

function resultOf(stack: MediaStack, taskId: string): Record<string, unknown> {
  return JSON.parse(latestAttempts(stageRunsOf(stack.h, taskId))[0]?.resultJson ?? "{}") as Record<string, unknown>;
}

function errorOf(stack: MediaStack, taskId: string) {
  return latestAttempts(stageRunsOf(stack.h, taskId))[0]?.error;
}

function insertCache(stack: MediaStack, contentId: string, fields: Partial<MediaAsset> & Pick<MediaAsset, "storageRef" | "mimeType">, userId = LOCAL.userId): MediaAsset {
  const asset: MediaAsset = {
    id: stack.h.newId(),
    userId,
    contentId,
    kind: "platform_cache",
    sizeBytes: 3,
    availability: "available",
    retentionPolicy: "evictable",
    createdAt: 1,
    ...fields,
  };
  stack.h.repository.withTransaction((scope) => scope.mediaAssets.insert(asset));
  return asset;
}

describe("CacheMediaStageExecutor: video", () => {
  it("registers media/<name>.<ext> under the frozen asset id, replaces only the older video cache and then evicts within the limit", async () => {
    const { stack, contentId, evictCalls, calls, fetchWith, inspectWith } = setup();
    const olderVideo = insertCache(stack, contentId, { storageRef: "media/第 1 讲 old.mp4", mimeType: "video/mp4", quality: "360" });
    await stack.stores.cache.writeAtomic(olderVideo.storageRef, Buffer.from("old"));
    const audio = insertCache(stack, contentId, { storageRef: "media/第 1 讲.mp3", mimeType: "audio/mpeg" });
    await stack.stores.cache.writeAtomic(audio.storageRef, MP3_BYTES);
    inspectWith(async () => ({ hasVideo: true, mimeType: "video/mp4", sizeBytes: MP4_BYTES.length, height: 720 }));
    fetchWith(async (_ref, _auth, opts, onProgress) => {
      onProgress(0.5);
      await writeFile(opts.output.path, MP4_BYTES);
      return { sizeBytes: MP4_BYTES.length, mimeType: "video/mp4", height: 720, acquisition: "guest" };
    });
    const assetId = "01CACHEASSET0000000000000A";
    const taskId = await runCache(stack, contentId, cacheRequest({ quality: 720, assetId }));
    expect(taskOf(stack.h, taskId).statusProjection).toBe("succeeded");
    expect(calls).toEqual([
      { method: "inspectVideo", maxHeight: 720 },
      { method: "fetchVideo", maxHeight: 720, maxBytes: CACHE_MEDIA_MAX_GB * BYTES_PER_GB },
    ]);

    expect(resultOf(stack, taskId)).toEqual({
      assetId,
      fileName: "第 1 讲.mp4",
      requestedType: "video",
      actualType: "video",
      evicted: [olderVideo.id, "evicted-elsewhere"],
    });
    expect(evictCalls).toEqual([[LOCAL.userId, assetId]]);
    const caches = cachesOf(stack, contentId);
    const fresh = caches.find((asset) => asset.id === assetId);
    expect(fresh).toMatchObject({
      kind: "platform_cache", storageRef: "media/第 1 讲.mp4", displayName: "第 1 讲.mp4", mimeType: "video/mp4", sizeBytes: MP4_BYTES.length,
      quality: "720", acquisition: "guest", availability: "available", retentionPolicy: "evictable",
    });
    expect(fresh).not.toHaveProperty("taskId");
    expect(fresh?.fingerprint).toBe(await stack.stores.cache.digest("media/第 1 讲.mp4"));
    expect(existsSync(join(stack.stores.cache.directory(), "第 1 讲.mp4"))).toBe(true);
    // The older video is replaced and its file removed; the audio cache of the same Content stays.
    expect(caches.find((asset) => asset.id === olderVideo.id)?.availability).toBe("evicted");
    expect(await stack.stores.cache.stat(olderVideo.storageRef)).toBeNull();
    expect(caches.find((asset) => asset.id === audio.id)?.availability).toBe("available");
    expect(await stack.stores.cache.stat(audio.storageRef)).not.toBeNull();
    // A cache is not Task-scoped: the janitor keeps it.
    await stack.janitor.whenIdle();
    expect(await stack.stores.cache.stat("media/第 1 讲.mp4")).not.toBeNull();
  });

  it("keeps a replaced cache's row evicted even when its file cannot be removed", async () => {
    const { stack, contentId, fetchWith, inspectWith } = setup();
    // A legacy ref the flat cache store refuses stands for a file that cannot be removed.
    const legacy = insertCache(stack, contentId, { storageRef: `assets/${LOCAL.userId}/${contentId}/old`, mimeType: "video/mp4" });
    inspectWith(async () => ({ hasVideo: true, mimeType: "video/webm" }));
    fetchWith(async (_ref, _auth, opts) => {
      await writeFile(opts.output.path, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]));
      return { sizeBytes: 8, mimeType: "video/webm", acquisition: "authenticated" };
    });
    const taskId = await runCache(stack, contentId, cacheRequest({ quality: 480 }));
    expect(taskOf(stack.h, taskId).statusProjection).toBe("succeeded");
    expect(resultOf(stack, taskId)).toMatchObject({ fileName: "第 1 讲.webm", evicted: [legacy.id, "evicted-elsewhere"] });
    // Without a height from the download, the requested tier is recorded.
    expect(cachesOf(stack, contentId).find((asset) => asset.storageRef === "media/第 1 讲.webm")).toMatchObject({ mimeType: "video/webm", quality: "480" });
    expect(cachesOf(stack, contentId).find((asset) => asset.id === legacy.id)?.availability).toBe("evicted");
  });

  it("refuses an announced size over the limit without downloading", async () => {
    const { stack, contentId, evictCalls, calls, inspectWith, fetchWith } = setup({ maxBytes: 100 });
    inspectWith(async () => ({ hasVideo: true, mimeType: "video/mp4", sizeBytes: 101 }));
    fetchWith(async () => {
      throw new Error("must not download");
    });
    const taskId = await runCache(stack, contentId, cacheRequest({ quality: 1080 }));
    expect(errorOf(stack, taskId)?.class).toBe("media_too_large");
    expect(calls.map((call) => call.method)).toEqual(["inspectVideo"]);
    expect(cachesOf(stack, contentId)).toEqual([]);
    expect(evictCalls).toEqual([]);
  });

  it("hands the download a scratch directory on the cache directory's volume and removes it when the download ends", async () => {
    const { stack, contentId, fetchWith, inspectWith } = setup();
    inspectWith(async () => ({ hasVideo: true, mimeType: "video/mp4" }));
    const scratchDirs: string[] = [];
    fetchWith(async (_ref, _auth, opts) => {
      scratchDirs.push(opts.output.scratchDir);
      await writeFile(join(opts.output.scratchDir, "video.f30080.mp4"), "stream");
      await writeFile(opts.output.path, MP4_BYTES);
      return { sizeBytes: MP4_BYTES.length, mimeType: "video/mp4", acquisition: "guest" };
    });
    const assetId = "01CACHEASSET0000000000000S";
    const taskId = await runCache(stack, contentId, cacheRequest({ quality: 720, assetId }));
    expect(taskOf(stack.h, taskId).statusProjection).toBe("succeeded");
    expect(scratchDirs).toEqual([join(stack.stores.cache.directory(), ".amber-tmp", assetId)]);
    expect(readdirSync(stack.stores.cache.directory())).toEqual(["第 1 讲.mp4"]);
  });

  it("removes the scratch directory of a download that fails", async () => {
    const { stack, contentId, fetchWith, inspectWith } = setup();
    inspectWith(async () => ({ hasVideo: true, mimeType: "video/mp4" }));
    fetchWith(async (_ref, _auth, opts) => {
      await writeFile(join(opts.output.scratchDir, "video.f30080.mp4"), "stream");
      throw amberError("source_unreachable", "the stream broke off");
    });
    const taskId = await runCache(stack, contentId, cacheRequest({ quality: 720 }));
    expect(taskOf(stack.h, taskId).statusProjection).toBe("failed");
    expect(readdirSync(stack.stores.cache.directory())).toEqual([]);
  });

  it("passes the adapter's size refusal through and registers nothing", async () => {
    const { stack, contentId, evictCalls, fetchWith, inspectWith } = setup();
    inspectWith(async () => ({ hasVideo: true, mimeType: "video/mp4" }));
    fetchWith(async () => {
      throw amberError("media_too_large", "announced size exceeds the limit", { params: { limit: "20 GB" } });
    });
    const taskId = await runCache(stack, contentId, cacheRequest({ quality: 1080 }));
    expect(taskOf(stack.h, taskId).statusProjection).toBe("failed");
    expect(errorOf(stack, taskId)?.class).toBe("media_too_large");
    expect(cachesOf(stack, contentId)).toEqual([]);
    expect(evictCalls).toEqual([]);
  });

  it("removes a download that turns out larger than the limit and fails with media_too_large", async () => {
    const { stack, contentId, evictCalls, fetchWith, inspectWith } = setup({ maxBytes: 8 });
    inspectWith(async () => ({ hasVideo: true, mimeType: "video/mp4" }));
    fetchWith(async (_ref, _auth, opts) => {
      await writeFile(opts.output.path, MP4_BYTES);
      return { sizeBytes: MP4_BYTES.length, mimeType: "video/mp4", acquisition: "authenticated" };
    });
    const taskId = await runCache(stack, contentId, cacheRequest({ quality: 480 }));
    expect(errorOf(stack, taskId)?.class).toBe("media_too_large");
    expect(cachesOf(stack, contentId)).toEqual([]);
    expect(readdirSync(stack.stores.cache.directory())).toEqual([]);
    expect(evictCalls).toEqual([]);
  });

  it("fails with internal.tool_failed when the download is not the announced container", async () => {
    const { stack, contentId, fetchWith, inspectWith } = setup();
    inspectWith(async () => ({ hasVideo: true, mimeType: "video/mp4" }));
    fetchWith(async (_ref, _auth, opts) => {
      await writeFile(opts.output.path, MP4_BYTES);
      return { sizeBytes: MP4_BYTES.length, mimeType: "video/webm", acquisition: "guest" };
    });
    const taskId = await runCache(stack, contentId, cacheRequest({ quality: 720 }));
    expect(errorOf(stack, taskId)).toMatchObject({ class: "internal", code: "internal.tool_failed" });
    expect(cachesOf(stack, contentId)).toEqual([]);
    expect(readdirSync(stack.stores.cache.directory())).toEqual([]);
  });

  it("caches the audio as MP3 when the platform offers no picture, and says so", async () => {
    const { stack, contentId, calls, transcodes, inspectWith, fetchWith, audioWith } = setup();
    inspectWith(async () => ({ hasVideo: false }));
    fetchWith(async () => {
      throw new Error("must not download video");
    });
    audioWith(1000);
    const taskId = await runCache(stack, contentId, cacheRequest({ quality: 720, assetId: "01CACHEASSET0000000000000B" }));
    expect(taskOf(stack.h, taskId).statusProjection).toBe("succeeded");
    expect(calls.map((call) => call.method)).toEqual(["inspectVideo", "inspectAudio", "fetchAudio"]);
    expect(transcodes).toHaveLength(1);
    expect(resultOf(stack, taskId)).toEqual({
      assetId: "01CACHEASSET0000000000000B",
      fileName: "第 1 讲.mp3",
      requestedType: "video",
      actualType: "audio",
      evicted: ["evicted-elsewhere"],
      reasons: ["audio_only"],
    });
    // The client reads the fallback from the StageRun's reasons.
    const run = latestAttempts(stageRunsOf(stack.h, taskId))[0] as StageRun;
    expect(toStageRunDto(run).reasons).toEqual(["audio_only"]);
    const asset = cachesOf(stack, contentId)[0];
    expect(asset).toMatchObject({ id: "01CACHEASSET0000000000000B", storageRef: "media/第 1 讲.mp3", mimeType: "audio/mpeg" });
    expect(asset).not.toHaveProperty("quality");
  });

  it("refuses a name another cache, a pending purge or a foreign file took after submission, overwriting none", async () => {
    const { stack, contentId, fetchWith, inspectWith } = setup();
    inspectWith(async () => ({ hasVideo: true, mimeType: "video/mp4" }));
    fetchWith(async (_ref, _auth, opts) => {
      await writeFile(opts.output.path, MP4_BYTES);
      return { sizeBytes: MP4_BYTES.length, mimeType: "video/mp4", acquisition: "guest" };
    });
    const otherContent = stack.h.newId();
    stack.h.repository.withTransaction((scope) =>
      scope.contents.insert({ id: otherContent, userId: LOCAL.userId, source: { kind: "local" }, processingStatus: "succeeded", createdAt: 1, updatedAt: 1 }),
    );
    insertCache(stack, otherContent, { storageRef: "media/Taken.mp4", mimeType: "video/mp4" });
    const byRow = await runCache(stack, contentId, cacheRequest({ quality: 720, fileName: "taken" }));
    expect(errorOf(stack, byRow)?.class).toBe("conflict");

    await stack.stores.cache.writeAtomic("media/user file.mp4", Buffer.from("the user's own"));
    const byFile = await runCache(stack, contentId, cacheRequest({ quality: 720, fileName: "user file", assetId: "01CACHEASSET0000000000000C" }));
    expect(errorOf(stack, byFile)?.class).toBe("conflict");
    expect((await stack.stores.cache.stat("media/user file.mp4"))?.sizeBytes).toBe("the user's own".length);
    expect(cachesOf(stack, contentId)).toEqual([]);

    // A purged cache whose file is still to be removed keeps its name, case-insensitively.
    stack.h.repository.withTransaction((scope) => stack.fileDeleter.register(scope, [{ store: "cache", storageRef: "media/Purged.mp4", expectedSizeBytes: 9 }]));
    const byPending = await runCache(stack, contentId, cacheRequest({ quality: 720, fileName: "purged", assetId: "01CACHEASSET0000000000000D" }));
    expect(errorOf(stack, byPending)?.class).toBe("conflict");
    expect(cachesOf(stack, contentId)).toEqual([]);
  });
});

describe("CacheMediaStageExecutor: audio", () => {
  it("downloads the track into the data directory, transcodes it into the cache and removes the scratch file", async () => {
    const { stack, contentId, calls, transcodes, audioWith } = setup({ durationMs: 60_000 });
    const olderAudio = insertCache(stack, contentId, { storageRef: "media/第 1 讲.mp3", mimeType: "audio/mpeg" });
    await stack.stores.cache.writeAtomic(olderAudio.storageRef, MP3_BYTES);
    const video = insertCache(stack, contentId, { storageRef: "media/第 1 讲.mp4", mimeType: "video/mp4" });
    const progress: number[] = [];
    stack.h.bus.subscribe(({ event }) => {
      if (event.type === "stage.updated" && event.stageRun.stage === "cache_media" && event.stageRun.progress > 0) {
        progress.push(event.stageRun.progress);
      }
    });
    audioWith(4096);
    const taskId = await runCache(stack, contentId, { requestSchemaVersion: 2, type: "audio", fileName: "第 1 讲 (2)", assetId: "01CACHEASSET0000000000000D" });
    expect(taskOf(stack.h, taskId).statusProjection).toBe("succeeded");
    expect(calls).toEqual([{ method: "inspectAudio" }, { method: "fetchAudio", maxBytes: CACHE_MEDIA_MAX_GB * BYTES_PER_GB }]);
    expect(transcodes).toEqual([
      {
        input: join(stack.h.dir, "tmp", "platform", "01CACHEASSET0000000000000D"),
        output: join(stack.stores.cache.directory(), "第 1 讲 (2).mp3.partial"),
        bitrateKbps: CACHE_AUDIO_MP3_KBPS,
      },
    ]);
    expect(await stack.files.list("tmp/platform")).toEqual([]);
    expect(resultOf(stack, taskId)).toEqual({
      assetId: "01CACHEASSET0000000000000D",
      fileName: "第 1 讲 (2).mp3",
      requestedType: "audio",
      actualType: "audio",
      evicted: [olderAudio.id, "evicted-elsewhere"],
    });
    const caches = cachesOf(stack, contentId);
    expect(caches.find((asset) => asset.id === "01CACHEASSET0000000000000D")).toMatchObject({
      storageRef: "media/第 1 讲 (2).mp3", displayName: "第 1 讲 (2).mp3", mimeType: "audio/mpeg", sizeBytes: MP3_BYTES.length, availability: "available",
    });
    expect(caches.find((asset) => asset.id === olderAudio.id)?.availability).toBe("evicted");
    expect(await stack.stores.cache.stat(olderAudio.storageRef)).toBeNull();
    expect(caches.find((asset) => asset.id === video.id)?.availability).toBe("available");
    // Download 0–0.7, transcode 0.7–1, never backwards.
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress).toEqual(expect.arrayContaining([0.35, 0.7, 0.85, 1]));
  });

  it("checks the budget of both volumes before downloading: the track on the data volume, the MP3 (and the track when shared) on the cache volume", async () => {
    const durationMs = 3_600_000;
    const mp3 = Math.ceil(((durationMs / 1000) * CACHE_AUDIO_MP3_KBPS * 1000 * 1.1) / 8);
    const source = 50 * 1024 * 1024;
    const total = 1000 * GB;
    // Free space that leaves exactly `room` above both low-water rules of the defaults.
    const roomy = (room: number): Usage => ({ usedBytes: 1 * GB, freeBytes: 0.2 * total + room, totalBytes: total });
    const enoughForMp3Only = roomy(mp3 + 1);

    const shared = setup({ durationMs, sameVolume: true, dataUsage: roomy(source + 1), cacheUsage: enoughForMp3Only });
    shared.audioWith(source);
    const refused = await runCache(shared.stack, shared.contentId, { requestSchemaVersion: 2, type: "audio", fileName: "a", assetId: "01CACHEASSET0000000000000E" });
    expect(errorOf(shared.stack, refused)?.class).toBe("disk_low");
    expect(shared.calls.map((call) => call.method)).toEqual(["inspectAudio"]);

    const split = setup({ durationMs, sameVolume: false, dataUsage: roomy(source + 1), cacheUsage: enoughForMp3Only });
    split.audioWith(source);
    const accepted = await runCache(split.stack, split.contentId, { requestSchemaVersion: 2, type: "audio", fileName: "a", assetId: "01CACHEASSET0000000000000F" });
    expect(taskOf(split.stack.h, accepted).statusProjection).toBe("succeeded");

    const dataFull = setup({ durationMs, sameVolume: false, dataUsage: roomy(source - 1), cacheUsage: roomy(GB) });
    dataFull.audioWith(source);
    const noRoomForTrack = await runCache(dataFull.stack, dataFull.contentId, { requestSchemaVersion: 2, type: "audio", fileName: "a", assetId: "01CACHEASSET0000000000000G" });
    expect(errorOf(dataFull.stack, noRoomForTrack)?.class).toBe("disk_low");
  });

  it("refuses an announced track over the limit before the budget and the download", async () => {
    const { stack, contentId, calls, audioWith } = setup({ maxBytes: 100 });
    audioWith(101);
    const taskId = await runCache(stack, contentId, { requestSchemaVersion: 2, type: "audio", fileName: "a", assetId: "01CACHEASSET0000000000000H" });
    expect(errorOf(stack, taskId)?.class).toBe("media_too_large");
    expect(calls.map((call) => call.method)).toEqual(["inspectAudio"]);
  });

  it("removes a downloaded track larger than the limit, and the scratch file, with media_too_large", async () => {
    const { stack, contentId, transcodes, audioWith } = setup({ maxBytes: 8 });
    audioWith(undefined, Buffer.alloc(9));
    const taskId = await runCache(stack, contentId, { requestSchemaVersion: 2, type: "audio", fileName: "a", assetId: "01CACHEASSET0000000000000J" });
    expect(errorOf(stack, taskId)?.class).toBe("media_too_large");
    expect(transcodes).toEqual([]);
    expect(await stack.files.list("tmp/platform")).toEqual([]);
    // Nothing was committed: the cache directory is empty or was never created.
    const cacheDir = stack.stores.cache.directory();
    expect(existsSync(cacheDir) ? readdirSync(cacheDir) : []).toEqual([]);
  });
});

describe("CacheMediaStageExecutor: requests", () => {
  it("fails a schema v1 request with invalid_request.cache_request_outdated, not internal", async () => {
    const { stack, contentId, calls } = setup();
    const taskId = await runCache(stack, contentId, { quality: 720 });
    expect(taskOf(stack.h, taskId).statusProjection).toBe("failed");
    expect(errorOf(stack, taskId)).toMatchObject({ class: "invalid_request", code: "invalid_request.cache_request_outdated" });
    expect(calls).toEqual([]);
  });
});

describe("sniffMime", () => {
  it("tells MP4, WebM and MP3 (ID3 or a bare frame sync) apart", async () => {
    const files = new LocalFileStore(tempDataDir("amber-sniff-"));
    const cases: Array<[Buffer, string]> = [
      [MP4_BYTES, "video/mp4"],
      [Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]), "video/webm"],
      [MP3_BYTES, "audio/mpeg"],
      [Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0, 0, 0, 0, 0]), "audio/mpeg"],
      [Buffer.from("plain text here"), "application/octet-stream"],
    ];
    for (const [index, [body, mime]] of cases.entries()) {
      await files.writeAtomic(`tmp/sniff-${index}`, body);
      expect(await sniffMime(files, `tmp/sniff-${index}`)).toBe(mime);
    }
  });
});
