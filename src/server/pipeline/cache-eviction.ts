import { CACHE_MEDIA_MAX_GB } from "../../shared/defaults.ts";
import { BYTES_PER_GB } from "../../shared/units.ts";
import type { MediaAsset } from "../domain/media-asset.ts";
import type { Logger } from "../ports/logger.ts";
import type { Repository } from "../ports/repository.ts";
import type { CacheGate } from "./cache-gate.ts";
import type { TaskEventBus } from "./events.ts";
import type { CacheFileStore } from "./media-files.ts";
import { isTerminalProjection } from "./projection.ts";

export interface CacheEvictorOptions {
  repository: Repository;
  /** The cache store: eviction removes nothing anywhere else. */
  cache: Pick<CacheFileStore, "remove" | "isAvailable">;
  gate: Pick<CacheGate, "tryShared" | "exclusiveReason">;
  bus: TaskEventBus;
  logger: Logger;
  /** Defaults to `CACHE_MEDIA_MAX_GB`. */
  maxBytes?: number;
}

/**
 * Keeps each user's `platform_cache` total within `CACHE_MEDIA_MAX_GB`: oldest first, skipping a just-cached asset and assets whose Content has an
 * unfinished Task; runs again whenever any Task finishes and at start-up, so a skip only
 * lasts until the Task that caused it ends. Rows change in a transaction; files go after,
 * best effort.
 * A pass holds a shared cache lease and is skipped entirely while the cache is being moved
 * or its root is not mounted: rows are never marked `evicted` for files that are still there.
 */
export class CacheEvictor {
  private readonly options: CacheEvictorOptions;
  private readonly maxBytes: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: CacheEvictorOptions) {
    this.options = options;
    this.maxBytes = options.maxBytes ?? CACHE_MEDIA_MAX_GB * BYTES_PER_GB;
  }

  /** Re-evicts after every finished Task; returns the unsubscribe function. */
  start(): () => void {
    return this.options.bus.subscribe(({ userId, event }) => {
      if (event.type === "task.finished") {
        this.enqueue(async () => {
          await this.evict(userId);
        });
      }
    });
  }

  /** Resolves once every queued pass has run. */
  async whenIdle(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.queue;
      await current;
    } while (current !== this.queue);
  }

  /** Start-up pass over every user. */
  async sweep(): Promise<void> {
    const users = this.options.repository.withTransaction((scope) => scope.users.list().map((user) => user.id));
    let evicted = 0;
    for (const userId of users) {
      evicted += (await this.evict(userId)).length;
    }
    this.options.logger.info("cache_eviction_sweep_done", { evicted });
  }

  /** Evicts the owner's oldest eligible caches until the total fits; returns the evicted asset ids. */
  async evict(ownerUserId: string, keepAssetId?: string): Promise<string[]> {
    const release = this.options.gate.tryShared();
    if (release === undefined) {
      this.options.logger.info(`cache_eviction_skipped_${this.options.gate.exclusiveReason() ?? "cache_migration"}`);
      return [];
    }
    try {
      if (!(await this.options.cache.isAvailable())) {
        this.options.logger.info("cache_eviction_skipped_unavailable");
        return [];
      }
      return await this.evictLocked(ownerUserId, keepAssetId);
    } finally {
      release();
    }
  }

  private async evictLocked(ownerUserId: string, keepAssetId: string | undefined): Promise<string[]> {
    const evicted = this.options.repository.withTransaction((scope) => {
      const caches = scope.mediaAssets.listAvailableCaches(ownerUserId);
      let total = caches.reduce((sum, asset) => sum + asset.sizeBytes, 0);
      const busy = new Map<string, boolean>();
      const contentBusy = (contentId: string): boolean => {
        let value = busy.get(contentId);
        if (value === undefined) {
          value = scope.tasks.listByContent(ownerUserId, contentId).some((task) => !isTerminalProjection(task.statusProjection));
          busy.set(contentId, value);
        }
        return value;
      };
      const chosen: MediaAsset[] = [];
      for (const asset of caches) {
        if (total <= this.maxBytes) {
          break;
        }
        if (asset.id === keepAssetId || contentBusy(asset.contentId)) {
          continue;
        }
        scope.mediaAssets.update(ownerUserId, { ...asset, availability: "evicted" });
        total -= asset.sizeBytes;
        chosen.push(asset);
      }
      return chosen;
    });
    // Best effort: a file still open elsewhere (a player, an ffmpeg run) cannot go now; its
    // row is already `evicted`, so the start-up sweep removes it as Amber's leftover.
    for (const asset of evicted) {
      try {
        await this.options.cache.remove(asset.storageRef);
      } catch (error) {
        this.options.logger.warn("cache_evicted_file_remove_failed", { error: (error as NodeJS.ErrnoException | undefined)?.code ?? "error" });
      }
    }
    if (evicted.length > 0) {
      this.options.logger.info("cache_evicted", { count: evicted.length });
    }
    return evicted.map((asset) => asset.id);
  }

  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work).catch((error: unknown) => {
      this.options.logger.error("cache_eviction_failed", { error: String(error) });
    });
  }
}
