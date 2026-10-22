/** Returns a lease; calling it more than once is harmless. */
export type Release = () => void;

/**
 * Who holds the exclusive lease: a cache move, a backup export (the copy must see the same
 * cache files as its database snapshot), or the maintenance state before an update install
 * A caller turned away answers with the holder's own conflict.
 */
export const EXCLUSIVE_REASONS = ["cache_migration", "backup_export", "update_install"] as const;
export type ExclusiveReason = (typeof EXCLUSIVE_REASONS)[number];

/**
 * The cache gate: a read / write lease over the `platform_cache` files.
 * Anything that reads, writes or removes cache files while running (the scheduler's Task
 * drivers, eviction, deletions) holds a shared lease; moving the cache to another root
 * holds the exclusive one. Neither side ever waits: a caller that cannot take its lease
 * answers `conflict.*` or tries again on its next tick, so a move never blocks an HTTP
 * request and a long Task never blocks a move for longer than its own lifetime.
 */
export class CacheGate {
  private shared = 0;
  private exclusive: ExclusiveReason | undefined;

  /** A shared lease, or `undefined` while the exclusive one is held. Shared leases nest freely. */
  tryShared(): Release | undefined {
    if (this.exclusive !== undefined) {
      return undefined;
    }
    this.shared += 1;
    return this.once(() => {
      this.shared -= 1;
    });
  }

  /** The exclusive lease, or `undefined` while any lease is held. Never queues. */
  tryExclusive(reason: ExclusiveReason): Release | undefined {
    if (this.exclusive !== undefined || this.shared > 0) {
      return undefined;
    }
    this.exclusive = reason;
    return this.once(() => {
      this.exclusive = undefined;
    });
  }

  exclusiveHeld(): boolean {
    return this.exclusive !== undefined;
  }

  /** The holder of the exclusive lease, if any. */
  exclusiveReason(): ExclusiveReason | undefined {
    return this.exclusive;
  }

  sharedHeld(): number {
    return this.shared;
  }

  private once(release: () => void): Release {
    let released = false;
    return () => {
      if (!released) {
        released = true;
        release();
      }
    };
  }
}
