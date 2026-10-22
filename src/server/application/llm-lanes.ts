import { LLM_COOLDOWN_BASE_MS, LLM_COOLDOWN_JITTER, LLM_COOLDOWN_MAX_MS, LLM_WINDOW_INITIAL } from "../../shared/defaults.ts";
import type { ModelRef } from "../domain/model-ref.ts";
import type { Admission } from "../pipeline/fair-semaphore.ts";

/** What one finished call tells its lane; errors that say nothing about the upstream's load are `none`. */
export type LaneFeedback =
  | { kind: "success" }
  | { kind: "rate_limited"; retryAfterMs?: number }
  | { kind: "overloaded"; retryAfterMs?: number }
  | { kind: "none" };

/** Kept by a call from its grant: the lane round it was sent in. */
export interface LaneTicket {
  epoch: number;
}

/** What `finish` changed, for the caller to act on and log. */
export interface LaneEffect {
  /** The lane cools down until `cooldownUntil`: its waiters must be turned away. */
  cooling: boolean;
  /** Set when this call shrank or grew the window. */
  windowChange?: "limited" | "grown";
  /** Where the cooldown length came from, when this call started or extended one. */
  cooldownSource?: "retry_after" | "computed";
}

/**
 * The adaptive admission of one model lane: how many calls to one profile ×
 * model may be in flight, learned from the upstream's answers instead of a fixed limit.
 * Process memory only; nothing here is shared across processes or survives a restart.
 *
 * - The window starts at `LLM_WINDOW_INITIAL`. Until the first rate limit every success
 *   adds one (slow start probes an unknown service); afterwards one is added per stable
 *   round, `window` successes in a row. It only grows while calls are waiting for it and
 *   has no upper bound: the demand queued for the lane is what bounds it.
 * - A rate limit in the current round (`epoch`) opens a new round: window back to 1, one
 *   more limit round, and a cooldown. Other rate limits of the same round, which were
 *   in flight together, only extend the cooldown; old-round successes do not grow it.
 * - An overload only cools the lane down; it says nothing about how much it may carry.
 * - The cooldown is the upstream's `retry-after`, never capped, else
 *   `LLM_COOLDOWN_BASE_MS × 3^(limit rounds − 1)` capped at `LLM_COOLDOWN_MAX_MS` and
 *   stretched by a random 0–`LLM_COOLDOWN_JITTER`, so lanes sharing an upstream do not
 *   come back in step. Each stable round takes one limit round off again.
 */
export class LlmLane implements Admission<LaneTicket> {
  window = LLM_WINDOW_INITIAL;
  inFlight = 0;
  /** Calls queued for this lane right now; set by the gateway around its wait. */
  waiting = 0;
  /** Whether the lane ever met a rate limit; ends slow start. */
  limited = false;
  epoch = 0;
  limitRounds = 0;
  cooldownUntil = 0;
  private roundSuccesses = 0;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(now: () => number, random: () => number) {
    this.now = now;
    this.random = random;
  }

  admits(): boolean {
    return this.now() >= this.cooldownUntil && this.inFlight < this.window;
  }

  onGrant(): LaneTicket {
    this.inFlight += 1;
    return { epoch: this.epoch };
  }

  /** When the lane admits calls again, or `undefined` when it is not cooling down. */
  coolingUntil(): number | undefined {
    return this.now() < this.cooldownUntil ? this.cooldownUntil : undefined;
  }

  /** Ends one granted call. Must be called exactly once per grant, whatever happened. */
  finish(ticket: LaneTicket, feedback: LaneFeedback): LaneEffect {
    this.inFlight -= 1;
    const current = ticket.epoch === this.epoch;
    switch (feedback.kind) {
      case "success":
        return current ? this.succeeded() : { cooling: false };
      case "rate_limited": {
        let windowChange: LaneEffect["windowChange"];
        if (current) {
          this.epoch += 1;
          this.limited = true;
          this.window = 1;
          this.roundSuccesses = 0;
          this.limitRounds += 1;
          windowChange = "limited";
        }
        return { ...this.coolDown(feedback.retryAfterMs), ...(windowChange === undefined ? {} : { windowChange }) };
      }
      case "overloaded":
        // A burst of overload answers to calls sent together counts as one round.
        if (this.coolingUntil() === undefined) {
          this.limitRounds += 1;
        }
        return this.coolDown(feedback.retryAfterMs);
      case "none":
        return { cooling: false };
    }
  }

  private succeeded(): LaneEffect {
    if (!this.limited) {
      if (this.waiting > 0) {
        this.window += 1;
        return { cooling: false, windowChange: "grown" };
      }
      return { cooling: false };
    }
    this.roundSuccesses += 1;
    if (this.roundSuccesses < this.window) {
      return { cooling: false };
    }
    this.roundSuccesses = 0;
    this.limitRounds = Math.max(0, this.limitRounds - 1);
    if (this.waiting > 0) {
      this.window += 1;
      return { cooling: false, windowChange: "grown" };
    }
    return { cooling: false };
  }

  private coolDown(retryAfterMs: number | undefined): LaneEffect {
    const source = retryAfterMs === undefined ? "computed" : "retry_after";
    const wait = retryAfterMs ?? this.computedCooldownMs();
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + wait);
    return { cooling: this.coolingUntil() !== undefined, cooldownSource: source };
  }

  private computedCooldownMs(): number {
    const base = Math.min(LLM_COOLDOWN_BASE_MS * 3 ** (Math.max(1, this.limitRounds) - 1), LLM_COOLDOWN_MAX_MS);
    return Math.round(base * (1 + this.random() * LLM_COOLDOWN_JITTER));
  }
}

/**
 * Every model lane of the process, by profile × model. A changed profile gets new lane
 * objects: calls still running keep and finish their old lane, so its answers never reach
 * the new one.
 */
export class LlmLanes {
  private readonly lanes = new Map<string, LlmLane>();
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(now: () => number, random: () => number) {
    this.now = now;
    this.random = random;
  }

  get(modelRef: ModelRef): LlmLane {
    const key = laneKey(modelRef.providerProfileId, modelRef.modelId);
    let lane = this.lanes.get(key);
    if (lane === undefined) {
      lane = new LlmLane(this.now, this.random);
      this.lanes.set(key, lane);
    }
    return lane;
  }

  /** Forgets the lanes of a profile, or only of the listed models. */
  reset(providerProfileId: string, modelIds?: readonly string[]): void {
    for (const key of [...this.lanes.keys()]) {
      const [profileId, modelId] = JSON.parse(key) as [string, string];
      if (profileId === providerProfileId && (modelIds === undefined || modelIds.includes(modelId))) {
        this.lanes.delete(key);
      }
    }
  }
}

function laneKey(providerProfileId: string, modelId: string): string {
  return JSON.stringify([providerProfileId, modelId]);
}
