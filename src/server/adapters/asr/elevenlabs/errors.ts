import { amberError, type AmberError } from "../../../domain/errors.ts";
import { OutboundHttpError } from "../../../ports/outbound-http.ts";

/** Upstream text kept in an error: the service's error code and message, never request data. */
const UPSTREAM_MESSAGE_MAX_CHARS = 300;

/** Client-side statuses that describe a passing condition (request timeout, concurrent edit). */
const TRANSIENT_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 409]);
/**
 * Codes meaning the profile's model is not one the service runs for this request: an
 * unknown id (`model_not_found`, 404) or one that cannot do speech-to-text
 * (`unsupported_model`, 400). Documented on the API's error reference page.
 */
const MODEL_CODES: ReadonlySet<string> = new Set(["unsupported_model", "model_not_found"]);
/** Codes meaning the model exists but the account may not use it (403 `authorization_error`). */
const MODEL_PERMISSION_CODES: ReadonlySet<string> = new Set(["model_access_denied"]);
/** `detail.status` of a 401 for a restricted key lacking the called endpoint's permission. */
const MISSING_PERMISSIONS = "missing_permissions";

/** The multipart field naming the model; a validation error about it is about the model. */
const MODEL_PARAM = "model_id";

interface ErrorDetail {
  code?: string;
  status?: string;
  message?: string;
  /** The request field the error is about, mainly for validation errors. */
  param?: string;
}

/** The `detail` object of an error body: `{ type, code, message, status, param, … }`, or a 422 list. */
export function errorDetail(body: string): ErrorDetail {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    const detail = parsed.detail;
    if (typeof detail === "object" && detail !== null && !Array.isArray(detail)) {
      const record = detail as Record<string, unknown>;
      const result: ErrorDetail = {};
      for (const key of ["code", "status", "message", "param"] as const) {
        const value = record[key];
        if (typeof value === "string") {
          result[key] = value;
        }
      }
      return result;
    }
    if (Array.isArray(detail)) {
      const first = detail[0] as { msg?: unknown } | undefined;
      return typeof first?.msg === "string" ? { message: first.msg } : {};
    }
  } catch {
    // Not JSON: nothing is kept from it.
  }
  return {};
}

/**
 * Whether a refusal is about the model rather than the key, the address or the audio: a
 * model code, a validation error naming the model field, or a 404 that says "model" (an
 * unknown path answers 404 too, and stays a configuration error of the address or key).
 */
function aboutModel(status: number, code: string | undefined, detail: ErrorDetail): boolean {
  if (code !== undefined && MODEL_CODES.has(code)) {
    return true;
  }
  if (detail.param === MODEL_PARAM && (status === 400 || status === 404 || status === 422)) {
    return true;
  }
  return status === 404 && [detail.code, detail.status, detail.message].some((part) => part !== undefined && /model/iu.test(part));
}

/**
 * An HTTP error answer as an ASR error class. An answer with an
 * error status means the request was refused, not processed, so none of these is
 * `outcome_unknown`: rate limits and server errors retry by policy, everything else needs
 * the user.
 */
export function httpError(status: number, body: string): AmberError {
  const detail = errorDetail(body);
  const code = detail.code ?? detail.status;
  const upstream = [code, detail.message].filter((part) => part !== undefined).join(": ").slice(0, UPSTREAM_MESSAGE_MAX_CHARS);
  const options = upstream === "" ? {} : { upstreamMessage: upstream };
  const internal = `speech-to-text answered HTTP ${status}${code === undefined ? "" : ` (${code})`}`;
  // Running out of credits is 402 `insufficient_credits`; older answers said `quota_exceeded`.
  if (status === 402 || code === "insufficient_credits" || code === "quota_exceeded") {
    return amberError("asr_quota", internal, options);
  }
  // A restricted key without the endpoint's permission is valid, just under-scoped.
  if (detail.status === MISSING_PERMISSIONS) {
    return amberError("asr_failed", internal, { ...options, code: "asr_failed.permission" });
  }
  if (code !== undefined && MODEL_PERMISSION_CODES.has(code)) {
    return amberError("asr_failed", internal, { ...options, code: "asr_failed.permission" });
  }
  // Model refusals come before the status rules: a typed-in model id the service does not
  // know is a 400 or 404 about the model, not about the key.
  if (aboutModel(status, code, detail)) {
    return amberError("asr_failed", internal, { ...options, code: "asr_failed.model_unavailable" });
  }
  if (status === 401 || status === 403 || status === 404) {
    return amberError("asr_failed", internal, { ...options, code: "asr_failed.auth" });
  }
  if (status === 429 || status >= 500 || TRANSIENT_CLIENT_STATUSES.has(status)) {
    return amberError("asr_failed", internal, options);
  }
  // Remaining refusals (400 validation errors, 413, 415, 422) are about this request's
  // audio or parameters: sending it again cannot succeed.
  return amberError("asr_failed", internal, { ...options, code: "asr_failed.invalid_audio" });
}

/**
 * A transport failure of a paid submission: before the last request chunk reached the
 * socket the service cannot have processed it, afterwards it may have (and may bill).
 * The caller's own cancellation is passed through as is.
 */
export function transportError(error: unknown, signal: AbortSignal, paid: boolean): unknown {
  if (signal.aborted) {
    return signal.reason;
  }
  if (error instanceof OutboundHttpError) {
    if (error.phase === "after_send" && paid) {
      return amberError("asr_timeout", error.message);
    }
    return amberError("asr_failed", error.message, { code: "asr_failed.unreachable" });
  }
  return error;
}
