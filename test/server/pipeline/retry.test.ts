import { describe, expect, it } from "vitest";
import { appError } from "../../../src/server/domain/errors.ts";
import { backoffMs, mayRetry, sleep, toAppError } from "../../../src/server/pipeline/retry.ts";
import { RETRY_BASE_MS, RETRY_MAX } from "../../../src/shared/defaults.ts";

describe("RetryDisposition handling", () => {
  it("retries safe and policy failures up to RETRY_MAX, never outcome_unknown or never", () => {
    expect(mayRetry(appError("source_unreachable"), 1)).toBe(true);
    expect(mayRetry(appError("llm_rate_limited"), RETRY_MAX)).toBe(true);
    expect(mayRetry(appError("llm_rate_limited"), RETRY_MAX + 1)).toBe(false);
    expect(mayRetry(appError("llm_outcome_unknown"), 1)).toBe(false);
    expect(mayRetry(appError("asr_quota"), 1)).toBe(false);
  });

  it("backs off exponentially from RETRY_BASE_MS", () => {
    expect([1, 2, 3].map(backoffMs)).toEqual([RETRY_BASE_MS, RETRY_BASE_MS * 2, RETRY_BASE_MS * 4]);
  });

  it("treats anything that is not an AmberError as internal", () => {
    expect(toAppError(new Error("x"))).toMatchObject({ class: "internal", retryDisposition: "never" });
  });

  it("sleeps abortably", async () => {
    const controller = new AbortController();
    const pending = sleep(60_000, controller.signal);
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
  });
});
