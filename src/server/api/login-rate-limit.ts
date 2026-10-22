import { LOGIN_BACKOFF_BASE_MS, LOGIN_BACKOFF_MAX_MS, LOGIN_RATE_PER_MIN } from "../../shared/defaults.ts";

const WINDOW_MS = 60_000;
/** Buckets kept before stale ones are swept on the next write. */
const SWEEP_THRESHOLD = 1000;

interface Bucket {
  failures: number[];
  /** Over-limit responses so far; the k of the backoff formula. */
  strikes: number;
  blockedUntil: number;
}

/**
 * Login throttling: a username bucket and a source-IP bucket each count failures in a 60 s
 * sliding window. Beyond `LOGIN_RATE_PER_MIN` (or while a previous backoff runs) an attempt
 * is refused, the k-th refusal with
 * `Retry-After = min(LOGIN_BACKOFF_BASE_MS × 2^(k−1), LOGIN_BACKOFF_MAX_MS)`. A success
 * clears the username bucket. In-process state, valid because Amber runs as a single
 * process; nothing locks an account globally.
 */
export class LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** `undefined` when the attempt may proceed, else the backoff in milliseconds. */
  check(keys: { username: string; ip: string }): number | undefined {
    const now = this.now();
    let retryAfterMs: number | undefined;
    for (const key of [`u:${keys.username}`, `ip:${keys.ip}`]) {
      const bucket = this.buckets.get(key);
      if (bucket === undefined) {
        continue;
      }
      bucket.failures = bucket.failures.filter((at) => now - at < WINDOW_MS);
      if (bucket.blockedUntil > now || bucket.failures.length >= LOGIN_RATE_PER_MIN) {
        bucket.strikes += 1;
        const backoff = Math.min(LOGIN_BACKOFF_BASE_MS * 2 ** (bucket.strikes - 1), LOGIN_BACKOFF_MAX_MS);
        bucket.blockedUntil = now + backoff;
        retryAfterMs = Math.max(retryAfterMs ?? 0, backoff);
      } else if (bucket.failures.length === 0) {
        this.buckets.delete(key);
      }
    }
    return retryAfterMs;
  }

  recordFailure(keys: { username: string; ip: string }): void {
    const now = this.now();
    for (const key of [`u:${keys.username}`, `ip:${keys.ip}`]) {
      const bucket = this.buckets.get(key) ?? { failures: [], strikes: 0, blockedUntil: 0 };
      bucket.failures.push(now);
      this.buckets.set(key, bucket);
    }
    if (this.buckets.size > SWEEP_THRESHOLD) {
      this.sweep(now);
    }
  }

  recordSuccess(keys: { username: string }): void {
    this.buckets.delete(`u:${keys.username}`);
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.blockedUntil <= now && bucket.failures.every((at) => now - at >= WINDOW_MS)) {
        this.buckets.delete(key);
      }
    }
  }
}
