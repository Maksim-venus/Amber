import { RETRY_BASE_MS, RETRY_MAX } from "../../shared/defaults.ts";
import type { AppError, RetryDisposition } from "../../shared/errors.ts";
import { appError, isAmberError } from "../domain/errors.ts";

/** Only failures before sending and explicit retryable upstream answers retry on their own. */
export function retriesAutomatically(disposition: RetryDisposition): boolean {
  return disposition === "safe" || disposition === "policy";
}

/** Whether automatic retry number `retry` (1-based) is still allowed. */
export function mayRetry(error: AppError, retry: number): boolean {
  return retriesAutomatically(error.retryDisposition) && retry <= RETRY_MAX;
}

/** Wait before automatic retry number `retry` (1-based): `RETRY_BASE_MS × 2^(retry−1)`. */
export function backoffMs(retry: number): number {
  return RETRY_BASE_MS * 2 ** (retry - 1);
}

/** Anything that is not an AmberError is an unexpected fault: `internal`, never retried. */
export function toAppError(error: unknown): AppError {
  return isAmberError(error) ? error.appError : appError("internal");
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
