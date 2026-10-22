import { describe, expect, it } from "vitest";
import { LlmLane, LlmLanes } from "../../../src/server/application/llm-lanes.ts";
import { LLM_COOLDOWN_BASE_MS, LLM_COOLDOWN_JITTER, LLM_COOLDOWN_MAX_MS, LLM_WINDOW_INITIAL } from "../../../src/shared/defaults.ts";

function lane(random = 0): { lane: LlmLane; clock: { now: number } } {
  const clock = { now: 1_000_000 };
  return { lane: new LlmLane(() => clock.now, () => random), clock };
}

/** Grants `count` calls, as the semaphore would. */
const grant = (target: LlmLane, count: number) => Array.from({ length: count }, () => target.onGrant());

describe("LlmLane window", () => {
  it("starts at LLM_WINDOW_INITIAL and, before any limit, grows by one per success while calls wait", () => {
    const { lane: l } = lane();
    expect(l.window).toBe(LLM_WINDOW_INITIAL);
    const tickets = grant(l, 3);
    expect(l.admits()).toBe(false);
    l.waiting = 5;
    expect(l.finish(tickets[0]!, { kind: "success" })).toEqual({ cooling: false, windowChange: "grown" });
    expect(l.window).toBe(4);
    l.waiting = 0;
    // Nothing waits: no reason to widen.
    expect(l.finish(tickets[1]!, { kind: "success" })).toEqual({ cooling: false });
    expect(l.window).toBe(4);
  });

  it("drops to 1 on a rate limit, then grows one per stable round of `window` successes and takes a limit round off", () => {
    const { lane: l, clock } = lane();
    const [limited] = grant(l, 1);
    expect(l.finish(limited!, { kind: "rate_limited" })).toMatchObject({ cooling: true, windowChange: "limited", cooldownSource: "computed" });
    expect({ window: l.window, limited: l.limited, limitRounds: l.limitRounds, epoch: l.epoch }).toEqual({ window: 1, limited: true, limitRounds: 1, epoch: 1 });
    clock.now = l.cooldownUntil;
    l.waiting = 10;
    // Round of 1 → window 2, rounds 0.
    l.finish(l.onGrant(), { kind: "success" });
    expect([l.window, l.limitRounds]).toEqual([2, 0]);
    // A round of 2 takes two successes.
    l.finish(l.onGrant(), { kind: "success" });
    expect(l.window).toBe(2);
    l.finish(l.onGrant(), { kind: "success" });
    expect(l.window).toBe(3);
  });

  it("shrinks once per round: other rate limits of calls sent together and old-round successes change nothing but the cooldown", () => {
    const { lane: l, clock } = lane();
    const [a, b, c] = grant(l, 3);
    l.waiting = 4;
    l.finish(a!, { kind: "rate_limited" });
    const firstUntil = l.cooldownUntil;
    clock.now += 1000;
    const late = l.finish(b!, { kind: "rate_limited" });
    expect(late).toMatchObject({ cooling: true });
    expect(late.windowChange).toBeUndefined();
    expect({ window: l.window, limitRounds: l.limitRounds, epoch: l.epoch }).toEqual({ window: 1, limitRounds: 1, epoch: 1 });
    // The late answer extends the cooldown by the current round's length from now.
    expect(l.cooldownUntil).toBe(firstUntil + 1000);
    l.finish(c!, { kind: "success" });
    expect({ window: l.window, limitRounds: l.limitRounds, inFlight: l.inFlight }).toEqual({ window: 1, limitRounds: 1, inFlight: 0 });
  });
});

describe("LlmLane cooldown", () => {
  it("waits BASE × 3^(round − 1), capped at LLM_COOLDOWN_MAX_MS, stretched by up to LLM_COOLDOWN_JITTER", () => {
    const { lane: l, clock } = lane();
    const waits: number[] = [];
    for (let round = 1; round <= 5; round += 1) {
      const start = clock.now;
      l.finish(l.onGrant(), { kind: "rate_limited" });
      waits.push(l.cooldownUntil - start);
      clock.now = l.cooldownUntil;
    }
    expect(waits).toEqual([LLM_COOLDOWN_BASE_MS, LLM_COOLDOWN_BASE_MS * 3, LLM_COOLDOWN_BASE_MS * 9, LLM_COOLDOWN_MAX_MS, LLM_COOLDOWN_MAX_MS]);
    const { lane: spread, clock: spreadClock } = lane(0.999);
    spread.finish(spread.onGrant(), { kind: "rate_limited" });
    const stretched = spread.cooldownUntil - spreadClock.now;
    expect(stretched).toBeGreaterThan(LLM_COOLDOWN_BASE_MS);
    expect(stretched).toBeLessThanOrEqual(LLM_COOLDOWN_BASE_MS * (1 + LLM_COOLDOWN_JITTER));
  });

  it("takes the upstream's retry-after first, without any cap", () => {
    const { lane: l, clock } = lane();
    expect(l.finish(l.onGrant(), { kind: "rate_limited", retryAfterMs: 900_000 })).toMatchObject({ cooldownSource: "retry_after" });
    expect(l.cooldownUntil - clock.now).toBe(900_000);
    expect(l.coolingUntil()).toBe(l.cooldownUntil);
    expect(l.admits()).toBe(false);
    clock.now = l.cooldownUntil;
    expect(l.coolingUntil()).toBeUndefined();
    expect(l.admits()).toBe(true);
  });

  it("only cools down on overload, one limit round per burst, leaving the window alone", () => {
    const { lane: l, clock } = lane();
    const [a, b] = grant(l, 2);
    expect(l.finish(a!, { kind: "overloaded" })).toEqual({ cooling: true, cooldownSource: "computed" });
    l.finish(b!, { kind: "overloaded", retryAfterMs: 1000 });
    expect({ window: l.window, limited: l.limited, epoch: l.epoch, limitRounds: l.limitRounds }).toEqual({
      window: LLM_WINDOW_INITIAL,
      limited: false,
      epoch: 0,
      limitRounds: 1,
    });
    expect(l.cooldownUntil - clock.now).toBe(LLM_COOLDOWN_BASE_MS);
  });

  it("learns nothing from other failures", () => {
    const { lane: l } = lane();
    expect(l.finish(l.onGrant(), { kind: "none" })).toEqual({ cooling: false });
    expect({ window: l.window, inFlight: l.inFlight, cooldownUntil: l.cooldownUntil }).toEqual({ window: LLM_WINDOW_INITIAL, inFlight: 0, cooldownUntil: 0 });
  });
});

describe("LlmLanes", () => {
  it("keeps one lane per profile × model and starts over for a changed profile or its removed models", () => {
    const lanes = new LlmLanes(() => 0, () => 0);
    const a = lanes.get({ providerProfileId: "p1", modelId: "a" });
    const b = lanes.get({ providerProfileId: "p1", modelId: "b" });
    const other = lanes.get({ providerProfileId: "p2", modelId: "a" });
    expect(lanes.get({ providerProfileId: "p1", modelId: "a" })).toBe(a);
    lanes.reset("p1", ["b"]);
    expect(lanes.get({ providerProfileId: "p1", modelId: "a" })).toBe(a);
    expect(lanes.get({ providerProfileId: "p1", modelId: "b" })).not.toBe(b);
    lanes.reset("p1");
    expect(lanes.get({ providerProfileId: "p1", modelId: "a" })).not.toBe(a);
    expect(lanes.get({ providerProfileId: "p2", modelId: "a" })).toBe(other);
  });
});
