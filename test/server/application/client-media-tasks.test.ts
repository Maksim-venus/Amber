import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClientMediaTaskService } from "../../../src/server/application/client-media-tasks.ts";
import { amberError } from "../../../src/server/domain/errors.ts";
import type { MediaInspection } from "../../../src/server/ports/subtitle-muxer.ts";
import { defaultSubtitleAppearance, defaultSubtitlePlacement } from "../../../src/shared/subtitle-style.ts";
import { BYTES_PER_GB } from "../../../src/shared/units.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import type { MediaAsset } from "../../../src/server/domain/media-asset.ts";
import { cacheFileNameOf } from "../../../src/shared/cache-file-name.ts";
import { CACHE_MEDIA_MAX_HEIGHT } from "../../../src/shared/defaults.ts";
import { cacheFile } from "../../../src/shared/i18n/zh-CN/cache-file.ts";
import { addLocalFile, seedExportContent } from "../../fixtures/export/export-data.ts";
import {
  BOB,
  createHarness,
  createLocalContent,
  createTaskOfKind,
  LOCAL,
  stageRunsOf,
  StubDisk,
  taskOf,
  type Harness,
} from "../../fixtures/pipeline/harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

function setup() {
  const h = createHarness();
  harnesses.push(h);
  const cacheDir = join(h.dir, "media");
  mkdirSync(cacheDir);
  const probed: string[] = [];
  const cache = {
    available: true,
    dir: cacheDir,
    usage: new StubDisk(),
    diskUsage: () => {
      probed.push("cache");
      return cache.usage.diskUsage();
    },
    isAvailable: async () => cache.available,
    directory: () => cache.dir,
  };
  const data = {
    diskUsage: () => {
      probed.push("data");
      return h.disk.diskUsage();
    },
  };
  const inspected: string[] = [];
  const source = {
    inspection: {
      container: "mov,mp4,m4a,3gp,3g2,mj2",
      streams: [
        { index: 0, type: "video", codec: "h264", width: 1280, height: 720 },
        { index: 1, type: "audio", codec: "aac" },
      ],
    } as MediaInspection | Error,
  };
  const service = new ClientMediaTaskService({
    media: { storeFor: () => ({ pathOf: (ref: string) => join(h.dir, ref) }) },
    muxer: {
      inspect: async (path) => {
        inspected.push(path);
        if (source.inspection instanceof Error) throw source.inspection;
        return source.inspection;
      },
    },
    repository: h.repository,
    bus: h.bus,
    control: h.scheduler,
    disk: data,
    cache,
    cacheFileExists: (ref) => existsSync(join(cache.dir, cacheFileNameOf(ref))),
    pendingCacheRefs: () => h.fileDeleter.pendingCacheRefs(),
    settings: h.settings,
    newId: h.newId,
  });
  return { h, service, cache, cacheDir, probed, inspected, source };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isAmberError(error)) {
      return error.appError.code;
    }
    throw error;
  }
  throw new Error("expected a rejection");
}

function platformContent(h: Harness, options: { userId?: string; title?: string; customTitle?: string } = {}): string {
  const id = h.newId();
  // A platform identity is unique per user; each Content of a test gets its own video id.
  const videoId = id.slice(-11);
  h.repository.withTransaction((scope) =>
    scope.contents.insert({
      id,
      userId: options.userId ?? LOCAL.userId,
      source: { kind: "youtube", sourceUrl: `https://www.youtube.com/watch?v=${videoId}`, platformContentId: videoId },
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.customTitle === undefined ? {} : { customTitle: options.customTitle }),
      processingStatus: "succeeded",
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  return id;
}

function addCache(h: Harness, contentId: string, storageRef: string, fields: Partial<MediaAsset> = {}): MediaAsset {
  const asset: MediaAsset = {
    id: h.newId(),
    userId: LOCAL.userId,
    contentId,
    kind: "platform_cache",
    storageRef,
    mimeType: storageRef.endsWith(".mp3") ? "audio/mpeg" : "video/mp4",
    sizeBytes: 1,
    availability: "available",
    retentionPolicy: "evictable",
    createdAt: 1,
    ...fields,
  };
  h.repository.withTransaction((scope) => scope.mediaAssets.insert(asset));
  return asset;
}

/** The request frozen into the accepted Task. */
async function frozen(service: ClientMediaTaskService, h: Harness, contentId: string, body: Parameters<ClientMediaTaskService["cacheMedia"]>[2] = {}) {
  const accepted = await service.cacheMedia(LOCAL, contentId, body);
  return JSON.parse(taskOf(h, accepted.body.taskId).requestJson) as Record<string, unknown>;
}

/** Finishes every unfinished Task of the Content so the lane is free again. */
function finishTasks(h: Harness, contentId: string): void {
  h.db.prepare("UPDATE task SET status_projection = 'succeeded', finished_at = 1 WHERE content_id = ?").run(contentId);
}

describe("ClientMediaTaskService.cacheMedia", () => {
  it("freezes a v2 request with the default type, height tier, name and a fresh asset id, and replays by Idempotency-Key", async () => {
    const { h, service } = setup();
    const contentId = platformContent(h, { title: "Lecture: one" });
    const first = await service.cacheMedia(LOCAL, contentId, {}, "k-1");
    expect(first.status).toBe(202);
    const task = taskOf(h, first.body.taskId);
    expect(task).toMatchObject({ kind: "cache_media", contentId });
    const request = JSON.parse(task.requestJson) as Record<string, unknown>;
    expect(request).toEqual({ requestSchemaVersion: 2, kind: "cache_media", type: "video", quality: CACHE_MEDIA_MAX_HEIGHT, fileName: "Lecture one", assetId: expect.any(String) });
    expect(request["assetId"]).not.toBe(task.id);
    expect(stageRunsOf(h, task.id).map((run) => run.stage)).toEqual(["cache_media"]);

    const replay = await service.cacheMedia(LOCAL, contentId, {}, "k-1");
    expect(replay).toMatchObject({ replayed: true, body: { taskId: task.id } });
    expect(await codeOf(service.cacheMedia(LOCAL, contentId, { quality: 360 }, "k-1"))).toBe("idempotency_conflict");
  });

  it("freezes an audio request without a height tier", async () => {
    const { h, service } = setup();
    const contentId = platformContent(h, { title: "Talk" });
    expect(await frozen(service, h, contentId, { type: "audio" })).toEqual({
      requestSchemaVersion: 2, kind: "cache_media", type: "audio", fileName: "Talk", assetId: expect.any(String),
    });
  });

  it("names the file after the cleaned request name, else the display title, else the i18n default", async () => {
    const { h, service } = setup();
    const named = platformContent(h, { title: "Platform title" });
    expect((await frozen(service, h, named, { fileName: '  课程: 第1讲?.MP4 ' }))["fileName"]).toBe("课程 第1讲");
    const renamed = platformContent(h, { title: "Platform title", customTitle: "My name" });
    expect((await frozen(service, h, renamed))["fileName"]).toBe("My name");
    // Unfinished Tasks hold their names; finish each so every case below may take the plain name.
    const finishAll = () => h.db.prepare("UPDATE task SET status_projection = 'succeeded', finished_at = 1").run();
    const untitled = platformContent(h);
    expect((await frozen(service, h, untitled))["fileName"]).toBe(cacheFile.untitled);
    finishAll();
    const symbols = platformContent(h, { title: "?*" });
    expect((await frozen(service, h, symbols))["fileName"]).toBe(cacheFile.untitled);
    finishAll();
    // A name the user cleared, or one that cleans to nothing, is untitled rather than the title.
    for (const fileName of ["", "  ::  ", "///"]) {
      const titled = platformContent(h, { title: "Platform title" });
      expect((await frozen(service, h, titled, { fileName }))["fileName"], JSON.stringify(fileName)).toBe(cacheFile.untitled);
      finishAll();
    }
  });

  it("gives a same-type re-cache the next free name and lets the other type share the stem", async () => {
    const { h, service } = setup();
    const contentId = platformContent(h, { title: "T" });
    addCache(h, contentId, "media/T.mp4");
    expect((await frozen(service, h, contentId, { type: "video" }))["fileName"]).toBe("T (2)");
    finishTasks(h, contentId);
    expect((await frozen(service, h, contentId, { type: "audio" }))["fileName"]).toBe("T");
    finishTasks(h, contentId);
    // An evicted cache no longer holds its name.
    const evicted = platformContent(h, { title: "Gone" });
    addCache(h, evicted, "media/Gone.mp4", { availability: "evicted" });
    expect((await frozen(service, h, evicted))["fileName"]).toBe("Gone");
  });

  it("skips names taken case-insensitively by another Content's cache, of any user and either type", async () => {
    const { h, service } = setup();
    const other = platformContent(h, { userId: BOB.userId, title: "x" });
    addCache(h, other, "media/t.mp3", { userId: BOB.userId });
    const contentId = platformContent(h, { title: "T" });
    expect((await frozen(service, h, contentId))["fileName"]).toBe("T (2)");
  });

  it("skips names frozen in unfinished cache Tasks of any user", async () => {
    const { h, service } = setup();
    const other = platformContent(h, { userId: BOB.userId, title: "T" });
    createTaskOfKind(h, "cache_media", { requestSchemaVersion: 2, type: "video", quality: 720, fileName: "T", assetId: h.newId() }, { contentId: other, userId: BOB.userId });
    // A finished Task frees its name.
    const done = platformContent(h, { title: "U" });
    createTaskOfKind(h, "cache_media", { requestSchemaVersion: 2, type: "video", quality: 720, fileName: "U", assetId: h.newId() }, { contentId: done });
    finishTasks(h, done);
    expect((await frozen(service, h, platformContent(h, { title: "T" })))["fileName"]).toBe("T (2)");
    expect((await frozen(service, h, platformContent(h, { title: "U" })))["fileName"]).toBe("U");
  });

  it("skips names of purged caches still waiting to be removed from the cache directory, even this Content's own", async () => {
    const { h, service } = setup();
    // Purged, the file not removed yet (or already gone): its name stays taken until the row goes.
    h.repository.withTransaction((scope) => h.fileDeleter.register(scope, [{ store: "cache", storageRef: "media/T.mp3", expectedSizeBytes: 5 }]));
    const contentId = platformContent(h, { title: "T" });
    expect((await frozen(service, h, contentId, { type: "audio" }))["fileName"]).toBe("T (2)");
  });

  it("skips names of files already in the cache directory, except this Content's own file of the other type", async () => {
    const { h, service, cacheDir } = setup();
    writeFileSync(join(cacheDir, "T.webm"), "someone's file");
    expect((await frozen(service, h, platformContent(h, { title: "T" })))["fileName"]).toBe("T (2)");

    const contentId = platformContent(h, { title: "S" });
    addCache(h, contentId, "media/S.mp3");
    writeFileSync(join(cacheDir, "S.mp3"), "the audio cache");
    expect((await frozen(service, h, contentId, { type: "video" }))["fileName"]).toBe("S");
  });

  it("shortens the name to fit the Windows path limit and refuses a cache directory with no room left", async () => {
    const { h, service, cache } = setup();
    cache.dir = `C:\\${"d".repeat(200)}`;
    const name = (await frozen(service, h, platformContent(h, { title: "x".repeat(100) })))["fileName"] as string;
    expect(name.length).toBeLessThan(100);
    expect(cache.dir.length + 1 + name.length + ".webm.partial".length).toBeLessThanOrEqual(259);
    cache.dir = `C:\\${"d".repeat(250)}`;
    const refused = await service.cacheMedia(LOCAL, platformContent(h, { title: "x" }), {}).catch((error: unknown) => error);
    expect(isAmberError(refused) && refused.appError).toMatchObject({ class: "invalid_request", userMessage: "请求参数有误：fileName" });
  });

  it("keeps cache and burn Tasks on one Content apart, and each serial", async () => {
    const { h, service } = setup();
    const contentId = platformContent(h, { title: "T" });
    await service.cacheMedia(LOCAL, contentId, {});
    expect(await codeOf(service.cacheMedia(LOCAL, contentId, { type: "audio" }))).toBe("conflict.mutation_lane");
    finishTasks(h, contentId);
    createTaskOfKind(h, "burn", { mode: "original", revisionId: "r" }, { contentId });
    expect(await codeOf(service.cacheMedia(LOCAL, contentId, {}))).toBe("conflict.mutation_lane");
    // Other Contents are not affected.
    expect((await service.cacheMedia(LOCAL, platformContent(h, { title: "T" }), {})).status).toBe(202);
  });

  it("refuses local, unknown and foreign Contents", async () => {
    const { h, service } = setup();
    expect(await codeOf(service.cacheMedia(LOCAL, createLocalContent(h), {}))).toBe("invalid_request");
    expect(await codeOf(service.cacheMedia(LOCAL, "nope", {}))).toBe("not_found");
    expect(await codeOf(service.cacheMedia(LOCAL, platformContent(h, { userId: BOB.userId }), {}))).toBe("not_found");
  });

  it("checks the cache volume for a video, and both volumes for audio", async () => {
    const { h, service, cache, probed } = setup();
    await service.cacheMedia(LOCAL, platformContent(h), {});
    expect(probed).toEqual(["cache"]);
    probed.length = 0;
    await service.cacheMedia(LOCAL, platformContent(h), { type: "audio" });
    expect(probed).toEqual(["data", "cache"]);

    cache.usage.low();
    expect(await codeOf(service.cacheMedia(LOCAL, platformContent(h), {}))).toBe("disk_low");
    expect(await codeOf(service.cacheMedia(LOCAL, platformContent(h), { type: "audio" }))).toBe("disk_low");
    // A full data directory does not stop a video download onto a roomy cache volume, but stops audio.
    cache.usage.plenty();
    h.disk.low();
    expect((await service.cacheMedia(LOCAL, platformContent(h), {})).status).toBe(202);
    expect(await codeOf(service.cacheMedia(LOCAL, platformContent(h), { type: "audio" }))).toBe("disk_low");
  });

  it("refuses a cache Task while the cache root is not mounted", async () => {
    const { h, service, cache } = setup();
    cache.available = false;
    expect(await codeOf(service.cacheMedia(LOCAL, platformContent(h), {}))).toBe("conflict.cache_unavailable");
    cache.available = true;
    expect((await service.cacheMedia(LOCAL, platformContent(h), {})).status).toBe(202);
  });
});

describe("ClientMediaTaskService.burn", () => {
  it("accepts revisions the way subtitle export does and freezes them", async () => {
    const { h, service } = setup();
    const fixture = seedExportContent(h, LOCAL.userId, "local");
    addLocalFile(h, fixture.contentId, "lecture.mp4");
    const body = { mode: "bilingual" as const, revisionId: fixture.corrected.revision.id, translationRevisionId: fixture.translated.revision.id };
    const accepted = await service.burn(LOCAL, fixture.contentId, body, "b-1");
    expect(accepted.status).toBe(202);
    const task = taskOf(h, accepted.body.taskId);
    expect(task.kind).toBe("burn");
    expect(JSON.parse(task.requestJson)).toEqual({ requestSchemaVersion: 1, kind: "burn", ...body });
    expect(stageRunsOf(h, task.id).map((run) => run.stage)).toEqual(["burn"]);
    expect((await service.burn(LOCAL, fixture.contentId, body, "b-1")).body).toEqual({ taskId: task.id });

    // One burn at a time per Content.
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, { mode: "original", revisionId: fixture.asr.revision.id }))).toBe("conflict.mutation_lane");
    finishTasks(h, fixture.contentId);
    const original = await service.burn(LOCAL, fixture.contentId, { mode: "original", revisionId: fixture.asr.revision.id });
    expect(JSON.parse(taskOf(h, original.body.taskId).requestJson)).toEqual({ requestSchemaVersion: 1, kind: "burn", mode: "original", revisionId: fixture.asr.revision.id });
  });

  it("burns into a video cache only, never an audio cache, and waits for an unfinished cache Task", async () => {
    const { h, service } = setup();
    const fixture = seedExportContent(h, LOCAL.userId);
    const body = { mode: "original" as const, revisionId: fixture.asr.revision.id };
    addCache(h, fixture.contentId, "media/a.mp3");
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, body))).toBe("media_missing");
    addCache(h, fixture.contentId, "media/a.mp4");
    const cacheTask = await service.cacheMedia(LOCAL, fixture.contentId, { type: "audio" });
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, body))).toBe("conflict.mutation_lane");
    expect(taskOf(h, cacheTask.body.taskId).kind).toBe("cache_media");
    finishTasks(h, fixture.contentId);
    expect((await service.burn(LOCAL, fixture.contentId, body)).status).toBe(202);
  });

  it("refuses a translation as the original, a translation of another revision, unknown revisions and Contents without media", async () => {
    const { h, service } = setup();
    const fixture = seedExportContent(h, LOCAL.userId, "local");
    addLocalFile(h, fixture.contentId, "lecture.mp4");
    const { asr, corrected, translated } = fixture;
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, { mode: "original", revisionId: translated.revision.id }))).toBe("invalid_request");
    expect(
      await codeOf(service.burn(LOCAL, fixture.contentId, { mode: "translation", revisionId: asr.revision.id, translationRevisionId: translated.revision.id })),
    ).toBe("invalid_request");
    expect(
      await codeOf(service.burn(LOCAL, fixture.contentId, { mode: "bilingual", revisionId: corrected.revision.id, translationRevisionId: asr.revision.id })),
    ).toBe("invalid_request");
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, { mode: "original", revisionId: "nope" }))).toBe("not_found");
    const other = seedExportContent(h, LOCAL.userId, "local");
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, { mode: "original", revisionId: other.asr.revision.id }))).toBe("not_found");
    expect(await codeOf(service.burn(BOB, fixture.contentId, { mode: "original", revisionId: asr.revision.id }))).toBe("not_found");

    // No original and no cache available at submission.
    expect(await codeOf(service.burn(LOCAL, other.contentId, { mode: "original", revisionId: other.asr.revision.id }))).toBe("media_missing");
    h.repository.withTransaction((scope) => {
      for (const asset of scope.mediaAssets.listByContent(LOCAL.userId, fixture.contentId)) {
        scope.mediaAssets.update(LOCAL.userId, { ...asset, availability: "missing" });
      }
    });
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, { mode: "original", revisionId: asr.revision.id }))).toBe("media_missing");
  });
});

describe("ClientMediaTaskService.burn, styled exports", () => {
  const style = { appearance: { ...defaultSubtitleAppearance(), original: { fontSize: 50, color: "#abcdef" } }, placement: defaultSubtitlePlacement() };

  function styled(h: Harness) {
    const fixture = seedExportContent(h, LOCAL.userId, "local");
    const assetId = h.newId();
    h.repository.withTransaction((scope) =>
      scope.mediaAssets.insert({
        id: assetId, userId: LOCAL.userId, contentId: fixture.contentId, kind: "external_local", storageRef: "/media/lecture.mkv", displayName: "lecture.mkv",
        mimeType: "video/x-matroska", sizeBytes: 10, fingerprint: "sha256:abc", availability: "available", retentionPolicy: "keep", createdAt: 1,
      }),
    );
    const body = {
      mode: "bilingual" as const,
      revisionId: fixture.corrected.revision.id,
      translationRevisionId: fixture.translated.revision.id,
      delivery: "soft" as const,
      container: "mkv" as const,
      style,
    };
    return { fixture, assetId, body };
  }

  it("inspects the picked source and freezes it with its fingerprint, the delivery, the container and the parsed style", async () => {
    const { h, service, inspected } = setup();
    const { fixture, assetId, body } = styled(h);
    const accepted = await service.burn(LOCAL, fixture.contentId, body, "s-1");
    expect(accepted.status).toBe(202);
    expect(inspected).toEqual(["/media/lecture.mkv"]);
    const request = JSON.parse(taskOf(h, accepted.body.taskId).requestJson) as Record<string, unknown>;
    expect(request).toEqual({
      requestSchemaVersion: 2,
      kind: "burn",
      mode: "bilingual",
      revisionId: fixture.corrected.revision.id,
      translationRevisionId: fixture.translated.revision.id,
      source: { assetId, fingerprint: "sha256:abc" },
      delivery: "soft",
      container: "mkv",
      style: { ...style, appearance: { ...style.appearance, original: { fontSize: 50, color: "#ABCDEF" } } },
    });
    // A replay neither inspects nor creates again.
    expect((await service.burn(LOCAL, fixture.contentId, body, "s-1")).body).toEqual({ taskId: accepted.body.taskId });
    expect(inspected).toHaveLength(1);
  });

  it("refuses a soft MP4 of streams outside the MP4 rule, listing them; MKV and hard MP4 take them", async () => {
    const { h, service, source } = setup();
    const { fixture, body } = styled(h);
    source.inspection = {
      container: "matroska,webm",
      streams: [
        { index: 0, type: "video", codec: "vp9", width: 1920, height: 1080 },
        { index: 1, type: "audio", codec: "opus" },
        { index: 2, type: "subtitle", codec: "ass" },
        { index: 3, type: "video", codec: "mjpeg", attachedPic: true },
      ],
    };
    const failure = await service.burn(LOCAL, fixture.contentId, { ...body, container: "mp4" }).catch((error: unknown) => error);
    expect(isAmberError(failure) && failure.appError).toMatchObject({ code: "invalid_request.container_unsupported", details: { streams: ["0:video:vp9", "1:audio:opus"] } });
    expect((await service.burn(LOCAL, fixture.contentId, body)).status).toBe(202);
    finishTasks(h, fixture.contentId);
    expect((await service.burn(LOCAL, fixture.contentId, { ...body, delivery: "hard", container: "mp4" })).status).toBe(202);
  });

  it("needs room for an output the size of the source beyond the low-water mark", async () => {
    const { h, service } = setup();
    const { fixture, assetId, body } = styled(h);
    const free = h.disk.usage.freeBytes;
    const settings = h.settings.effective();
    // Just enough: what is left after the output still meets the absolute and the ratio mark.
    const floor = Math.max(settings.lowWaterFreeGB * BYTES_PER_GB, settings.lowWaterFreeRatio * h.disk.usage.totalBytes);
    const setSize = (sizeBytes: number) =>
      h.repository.withTransaction((scope) => scope.mediaAssets.update(LOCAL.userId, { ...(scope.mediaAssets.get(LOCAL.userId, assetId) as MediaAsset), sizeBytes }));
    setSize(free - floor + 1);
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, body))).toBe("disk_low");
    setSize(free - floor);
    expect((await service.burn(LOCAL, fixture.contentId, body)).status).toBe(202);
  });

  it("refuses without an available video, and reports an inspection failure as it comes", async () => {
    const { h, service, source, inspected } = setup();
    const { fixture, assetId, body } = styled(h);
    source.inspection = amberError("internal", "ffprobe exited with 1", { code: "internal.tool_failed" });
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, body))).toBe("internal.tool_failed");
    h.repository.withTransaction((scope) => scope.mediaAssets.update(LOCAL.userId, { ...(scope.mediaAssets.get(LOCAL.userId, assetId) as MediaAsset), availability: "missing" }));
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, body))).toBe("media_missing");
    // Revisions are checked before anything is inspected.
    expect(await codeOf(service.burn(LOCAL, fixture.contentId, { ...body, revisionId: "nope" }))).toBe("not_found");
    expect(inspected).toHaveLength(1);
  });
});
