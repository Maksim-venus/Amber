import { afterEach, describe, expect, it } from "vitest";
import type { MediaAsset } from "../../../src/server/domain/media-asset.ts";
import { CacheEvictor } from "../../../src/server/pipeline/cache-eviction.ts";
import { CacheGate } from "../../../src/server/pipeline/cache-gate.ts";
import { BOB, createHarness, createLocalContent, createTaskOfKind, LOCAL, silentLogger, taskOf, waitFor, type Harness } from "../../fixtures/pipeline/harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

function setup(maxBytes = 100) {
  const h = createHarness();
  harnesses.push(h);
  const removed: string[] = [];
  const cache = { available: true, remove: async (ref: string) => void removed.push(ref), isAvailable: async () => cache.available };
  const gate = new CacheGate();
  const evictor = new CacheEvictor({ repository: h.repository, cache, gate, bus: h.bus, logger: silentLogger, maxBytes });
  return { h, evictor, removed, cache, gate };
}

function addCache(h: Harness, contentId: string, sizeBytes: number, createdAt: number, userId = LOCAL.userId): MediaAsset {
  const id = h.newId();
  const asset: MediaAsset = {
    id,
    userId,
    contentId,
    kind: "platform_cache",
    storageRef: `media/${id}.mp4`,
    mimeType: "video/mp4",
    sizeBytes,
    quality: "1080",
    availability: "available",
    retentionPolicy: "evictable",
    createdAt,
  };
  h.repository.withTransaction((scope) => scope.mediaAssets.insert(asset));
  return asset;
}

const availabilityOf = (h: Harness, asset: MediaAsset) =>
  h.repository.withTransaction((scope) => scope.mediaAssets.get(asset.userId, asset.id)?.availability);

describe("CacheEvictor.evict", () => {
  it("evicts oldest first until the total fits, never the asset just cached, rows before files", async () => {
    const { h, evictor, removed } = setup();
    const a = createLocalContent(h);
    const b = createLocalContent(h);
    const oldest = addCache(h, a, 40, 1);
    const middle = addCache(h, b, 40, 2);
    const kept = addCache(h, a, 50, 0);
    const newest = addCache(h, b, 30, 4);
    // 160 bytes over a 100-byte limit: `kept` is skipped although it is the oldest.
    expect(await evictor.evict(LOCAL.userId, kept.id)).toEqual([oldest.id, middle.id]);
    expect(removed).toEqual([oldest.storageRef, middle.storageRef]);
    expect([oldest, middle, kept, newest].map((asset) => availabilityOf(h, asset))).toEqual(["evicted", "evicted", "available", "available"]);
    // Within the limit: nothing more to do.
    expect(await evictor.evict(LOCAL.userId)).toEqual([]);
  });

  it("skips caches whose Content has an unfinished Task and catches up when that Task finishes", async () => {
    const { h, evictor, removed } = setup();
    const stop = evictor.start();
    const busy = createLocalContent(h);
    const idle = createLocalContent(h);
    const busyCache = addCache(h, busy, 80, 1);
    const idleCache = addCache(h, idle, 30, 2);
    const fresh = addCache(h, idle, 60, 3);
    const taskId = createTaskOfKind(h, "burn", { mode: "original", revisionId: "r" }, { contentId: busy });

    // 170 bytes: the busy Content's cache is skipped, so the pass stops above the limit.
    expect(await evictor.evict(LOCAL.userId, fresh.id)).toEqual([idleCache.id]);
    expect(availabilityOf(h, busyCache)).toBe("available");

    h.tasks.cancel(LOCAL, taskId);
    await waitFor(() => taskOf(h, taskId).statusProjection === "cancelled");
    await evictor.whenIdle();
    expect(availabilityOf(h, busyCache)).toBe("evicted");
    expect(removed).toEqual([idleCache.storageRef, busyCache.storageRef]);
    const total = h.repository.withTransaction((scope) => scope.mediaAssets.listAvailableCaches(LOCAL.userId)).reduce((sum, asset) => sum + asset.sizeBytes, 0);
    expect(total).toBeLessThanOrEqual(100);
    stop();
  });

  it("does nothing while the cache is being moved or its root is not mounted", async () => {
    const { h, evictor, removed, cache, gate } = setup();
    const content = createLocalContent(h);
    const oldest = addCache(h, content, 90, 1);
    const newest = addCache(h, content, 90, 2);
    const release = gate.tryExclusive("cache_migration") as () => void;
    expect(await evictor.evict(LOCAL.userId)).toEqual([]);
    release();
    cache.available = false;
    expect(await evictor.evict(LOCAL.userId)).toEqual([]);
    expect([oldest, newest].map((asset) => availabilityOf(h, asset))).toEqual(["available", "available"]);
    expect(removed).toEqual([]);
    cache.available = true;
    expect(await evictor.evict(LOCAL.userId)).toEqual([oldest.id]);
    // The pass released its shared lease.
    expect(gate.tryExclusive("cache_migration")).toBeDefined();
  });

  it("sweeps every user at start-up and leaves other users' caches to their own limit", async () => {
    const { h, evictor } = setup();
    const mine = createLocalContent(h);
    const bobs = createLocalContent(h, BOB.userId);
    const myOld = addCache(h, mine, 90, 1);
    const myNew = addCache(h, mine, 90, 2);
    const bobOld = addCache(h, bobs, 60, 1, BOB.userId);
    const bobNew = addCache(h, bobs, 60, 2, BOB.userId);
    const bobOnly = addCache(h, bobs, 1, 3, BOB.userId);
    await evictor.sweep();
    expect([myOld, myNew, bobOld, bobNew, bobOnly].map((asset) => availabilityOf(h, asset))).toEqual(["evicted", "available", "evicted", "available", "available"]);
  });

  it("logs and survives a failing pass after a Task finishes", async () => {
    const errors: string[] = [];
    const h = createHarness();
    harnesses.push(h);
    const logger = { ...silentLogger, error: (message: string) => void errors.push(message) };
    const cache = { remove: async () => undefined, isAvailable: async () => Promise.reject(new Error("disk gone")) };
    const evictor = new CacheEvictor({ repository: h.repository, cache, gate: new CacheGate(), bus: h.bus, logger, maxBytes: 10 });
    const stop = evictor.start();
    const content = createLocalContent(h);
    addCache(h, content, 20, 1);
    const taskId = createTaskOfKind(h, "burn", { mode: "original", revisionId: "r" });
    h.tasks.cancel(LOCAL, taskId);
    await waitFor(() => taskOf(h, taskId).statusProjection === "cancelled");
    await evictor.whenIdle();
    expect(errors).toEqual(["cache_eviction_failed"]);
    stop();
  });

  it("evicts the rows even when a file cannot be removed now, leaving it to the start-up sweep", async () => {
    const warnings: string[] = [];
    const h = createHarness();
    harnesses.push(h);
    const logger = { ...silentLogger, warn: (message: string) => void warnings.push(message) };
    const attempted: string[] = [];
    const cache = {
      remove: async (ref: string) => {
        attempted.push(ref);
        if (attempted.length === 1) throw Object.assign(new Error("in use"), { code: "EBUSY" });
      },
      isAvailable: async () => true,
    };
    const evictor = new CacheEvictor({ repository: h.repository, cache, gate: new CacheGate(), bus: h.bus, logger, maxBytes: 10 });
    const content = createLocalContent(h);
    const busy = addCache(h, content, 20, 1);
    const next = addCache(h, content, 20, 2);
    const newest = addCache(h, content, 5, 3);
    expect(await evictor.evict(LOCAL.userId)).toEqual([busy.id, next.id]);
    expect(attempted).toEqual([busy.storageRef, next.storageRef]);
    expect([busy, next, newest].map((asset) => availabilityOf(h, asset))).toEqual(["evicted", "evicted", "available"]);
    expect(warnings).toEqual(["cache_evicted_file_remove_failed"]);
  });
});
