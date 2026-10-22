import { amberError, type AmberError } from "../../../domain/errors.ts";
import { OutboundHttpError } from "../../../ports/outbound-http.ts";

/** Upstream text kept in an error: the service's error code and message, never request data. */
const UPSTREAM_MESSAGE_MAX_CHARS = 300;
const MS_PER_SECOND = 1000;

/** Which request failed: the phases differ in what a refusal or a lost answer means. */
export type DashscopePhase = "policy" | "upload" | "submit" | "poll" | "result" | "cancel";

export interface UpstreamError {
  code?: string;
  message?: string;
}

/**
 * The `{ code, message }` of an error answer: JSON from the service itself, XML
 * (`<Code>` / `<Message>`) from the upload storage. Nothing else is kept from the body.
 */
export function upstreamError(body: string): UpstreamError {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const result: UpstreamError = {};
    if (typeof parsed["code"] === "string") {
      result.code = parsed["code"];
    }
    if (typeof parsed["message"] === "string") {
      result.message = parsed["message"];
    }
    return result;
  } catch {
    const code = /<Code>([^<]{1,100})<\/Code>/u.exec(body)?.[1];
    const message = /<Message>([^<]{1,500})<\/Message>/u.exec(body)?.[1];
    return { ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }) };
  }
}

/** `"<code>: <message>"`, cut to length; empty when the answer named neither. */
export function upstreamText(error: UpstreamError): string | undefined {
  const text = [error.code, error.message].filter((part) => part !== undefined && part !== "").join(": ").slice(0, UPSTREAM_MESSAGE_MAX_CHARS);
  return text === "" ? undefined : text;
}

/** A `Retry-After` header (seconds or an HTTP date) in milliseconds from `now`. */
export function retryAfterMs(header: string | undefined, now: number): number | undefined {
  if (header === undefined) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * MS_PER_SECOND);
  }
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * Refusals that mean the same in every phase: the account or key, never the request.
 * A 403 is told apart by its code first: the free tier running out with "stop when used
 * up" switched on is not a permission problem.
 */
function accountError(status: number, error: UpstreamError, internal: string, upstream: { upstreamMessage?: string }): AmberError | undefined {
  const code = error.code ?? "";
  if (code === "AllocationQuota.FreeTierOnly") {
    return amberError("asr_quota", internal, { ...upstream, code: "asr_quota.free_tier_exhausted" });
  }
  if (code === "Arrearage" || code.startsWith("AllocationQuota")) {
    return amberError("asr_quota", internal, upstream);
  }
  if (status === 401 || code === "InvalidApiKey") {
    return amberError("asr_failed", internal, { ...upstream, code: "asr_failed.auth" });
  }
  if (code.startsWith("AccessDenied") || code === "Model.AccessDenied" || code === "Workspace.AccessDenied") {
    return amberError("asr_failed", internal, { ...upstream, code: "asr_failed.permission" });
  }
  if (code === "ModelNotFound" || code === "Model.NotFound" || code === "ModelNotExist") {
    return amberError("asr_failed", internal, { ...upstream, code: "asr_failed.model_unavailable" });
  }
  return undefined;
}

/**
 * An HTTP error answer of `phase` as an ASR error, mapped per call phase. An error
 * status means the request was refused, so only the job submission's server errors are
 * `asr_timeout`: creating a job is not idempotent and a 5xx does not prove no job exists.
 */
export function httpError(phase: DashscopePhase, status: number, body: string, headers: ReadonlyMap<string, string>, now: number): AmberError {
  const error = upstreamError(body);
  const text = upstreamText(error);
  const upstream = text === undefined ? {} : { upstreamMessage: text };
  const internal = `dashscope ${phase} answered HTTP ${status}${error.code === undefined ? "" : ` (${error.code})`}`;
  if (status === 429) {
    const wait = retryAfterMs(headers.get("retry-after"), now);
    return amberError("asr_failed", internal, { ...upstream, code: "asr_failed.rate_limited", ...(wait === undefined ? {} : { details: { retryAfterMs: wait } }) });
  }
  if (phase === "upload") {
    // The upload storage: an expired or refused policy, throttling and server errors are
    // retried with a fresh policy; anything else is about this file.
    if (status === 403 || status >= 500 || status === 408) {
      return amberError("asr_failed", internal, upstream);
    }
    return amberError("asr_failed", internal, { ...upstream, code: "asr_failed.invalid_audio" });
  }
  const account = accountError(status, error, internal, upstream);
  if (account !== undefined) {
    return account;
  }
  if (status >= 500 || status === 408) {
    return phase === "submit" ? amberError("asr_timeout", internal, upstream) : amberError("asr_failed", internal, upstream);
  }
  switch (phase) {
    case "policy":
      // Asking for upload space takes only the model, so a refusal is about the model.
      return amberError("asr_failed", internal, { ...upstream, code: "asr_failed.model_unavailable" });
    case "submit":
      if (status === 404) {
        return amberError("asr_failed", internal, { ...upstream, code: "asr_failed.model_unavailable" });
      }
      // `InvalidParameter`, `InvalidFile.*`, `DataInspectionFailed` and any other refusal
      // are about this request's audio or parameters: sending it again cannot succeed.
      return amberError("asr_failed", internal, { ...upstream, code: "asr_failed.invalid_audio" });
    case "result":
      // The result link is signed and lives as long as the job; refused means it is gone.
      return status === 403 || status === 404
        ? amberError("asr_failed", internal, { ...upstream, code: "asr_failed.job_expired" })
        : amberError("asr_failed", internal, { ...upstream, code: "asr_failed.job_failed" });
    case "poll":
    case "cancel":
      return amberError("asr_failed", internal, { ...upstream, code: "asr_failed.job_failed" });
  }
}

/** Terminal job codes meaning the audio holds nothing to transcribe. */
const NO_SPEECH_CODES: ReadonlySet<string> = new Set([
  "SUCCESS_WITH_NO_VALID_FRAGMENT",
  "ASR_RESPONSE_HAVE_NO_WORDS",
  "NO_INPUT_AUDIO_ERROR",
  "NO_VALID_AUDIO_ERROR",
]);
/** Terminal job codes meaning the file itself was refused. */
const INVALID_AUDIO_CODES: ReadonlySet<string> = new Set([
  "FILE_TOO_LARGE",
  "AUDIO_DURATION_TOO_LONG",
  "FILE_CHECK_FAILED",
  "FILE_NORMALIZE_FAILED",
  "FILE_PARSE_FAILED",
  "MKV_PARSE_FAILED",
  "DECODE_ERROR",
]);
const EXPIRED_CODES: ReadonlySet<string> = new Set(["FILE_TRANS_TASK_EXPIRED"]);

/** A job (or its only file) that ended in failure on the service's side. */
export function jobError(error: UpstreamError, status: string): AmberError {
  const text = upstreamText(error);
  const upstream = text === undefined ? {} : { upstreamMessage: text };
  const code = error.code ?? "";
  const internal = `dashscope job ended ${status}${code === "" ? "" : ` (${code})`}`;
  if (status === "CANCELED" || EXPIRED_CODES.has(code)) {
    return amberError("asr_failed", internal, { ...upstream, code: "asr_failed.job_expired" });
  }
  if (NO_SPEECH_CODES.has(code)) {
    return amberError("media_no_audio", internal, upstream);
  }
  if (INVALID_AUDIO_CODES.has(code)) {
    return amberError("asr_failed", internal, { ...upstream, code: "asr_failed.invalid_audio" });
  }
  return amberError("asr_failed", internal, { ...upstream, code: "asr_failed.job_failed" });
}

/**
 * A transport failure. Only the job submission is paid: once its last chunk left, the job
 * may exist, so its outcome is unknown. Every other request is free and simply retried.
 * The caller's own cancellation is passed through as is.
 */
export function transportError(error: unknown, signal: AbortSignal, phase: DashscopePhase): unknown {
  if (signal.aborted) {
    return signal.reason;
  }
  if (error instanceof OutboundHttpError) {
    if (error.phase === "after_send" && phase === "submit") {
      return amberError("asr_timeout", error.message);
    }
    return amberError("asr_failed", error.message, { code: "asr_failed.unreachable" });
  }
  return error;
}
