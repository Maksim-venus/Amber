import { amberError, sanitizeUpstreamText, type AmberError, type AppErrorOptions } from "../../domain/errors.ts";

/**
 * Evidence-tiered reading of LLM error answers, shared by both protocol adapters.
 * Relays answer limits in every shape: a 429 may mean "out of money", a
 * 400 may mean "spend limit reached", a bare 429 may mean either. Classification reads a
 * fixed set of fields, tries explicit codes before wording and wording before bare
 * statuses, and calls a limit it cannot place `limit_ambiguous` instead of guessing:
 * retrying a drained account only burns the retry budget, giving up on a rate limit
 * loses a recoverable task.
 */

/** Upstream text kept in an error: codes and message of the answer, never request data. */
export const UPSTREAM_MESSAGE_MAX_CHARS = 300;

/** What an HTML body (a gateway or WAF page) leaves in the message instead of its markup. */
export const HTML_PAGE_PLACEHOLDER = "(HTML page)";

/** The fixed fields an error answer is read from; nothing else of the body is looked at. */
export interface UpstreamErrorEvidence {
  status: number;
  /** `error.code`, `error.details.error_code`, `error.type`, top-level `code`, `error_code`. */
  code?: string;
  detailsCode?: string;
  type?: string;
  topCode?: string;
  topErrorCode?: string;
  /** Sanitized and capped; the placeholder for an HTML page. */
  message?: string;
  /** From a valid `retry-after` header; 0 for a date already past. */
  retryAfterMs?: number;
}

/** Why a limit verdict was reached; logged, never the upstream text itself. */
export type LimitEvidence =
  | "quota_code"
  | "status_402"
  | "quota_text"
  | "overload_code"
  | "rate_code"
  | "rate_text"
  | "overload_text"
  | "retry_after"
  | "status_429"
  | "status_overload";

export type LimitKind = "quota" | "overloaded" | "rate_limited" | "limit_ambiguous";

export interface LimitVerdict {
  kind: LimitKind;
  evidence: LimitEvidence;
}

// Vendor codes, matched case-insensitively and exactly. Sources: OpenAI error codes,
// Anthropic errors, Kimi and DeepSeek error references.
const QUOTA_CODES: ReadonlySet<string> = new Set([
  "credit_balance_exhausted",
  "insufficient_quota",
  "insufficient_balance",
  "billing_hard_limit_reached",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "usage_limit_exceeded",
  "enforced_spend_limit_reached",
  "exceeded_current_quota_error",
  "billing_error",
]);
const OVERLOAD_CODES: ReadonlySet<string> = new Set(["server_is_overloaded", "service_unavailable_error", "overloaded_error", "engine_overloaded_error"]);
const RATE_CODES: ReadonlySet<string> = new Set(["rate_limit_exceeded", "rate_limit_error", "slow_down", "rate_limit_reached_error"]);

// Only wording that names one cause decides. "quota", 「额度」, "usage limit", "limit
// exceeded" and 「稍后重试」 appear in rate-limit and quota answers alike (「TPM 额度」 is a
// rate), so they never do; 「额度不足」「额度已用尽」 say the account has run dry.
const QUOTA_TEXT =
  /余额不足|余额已用尽|余额耗尽|额度不足|额度已用尽|请充值|充值后|欠费|insufficient (balance|credits?|funds)|credit balance|(spend|billing|hard) limit (reached|exceeded)|reached your (specified )?(api )?usage limits/i;
const RATE_TEXT =
  /too many requests|rate[ _-]?limit|slow down|requests? per (second|minute|day)|tokens? per (minute|day)|\bRPM\b|\bTPM\b|\bTPD\b|请求(过于|太)?频繁|请求(频率|速率)|限流|每分钟|并发(数)?(超|达到|过)/i;
const OVERLOAD_TEXT = /overloaded|server (is )?busy|服务器繁忙|负载过高|系统繁忙/i;

const RATE_LIMITED_STATUS = 429;
const PAYMENT_REQUIRED_STATUS = 402;
/** Service unavailable, and the Messages API's own "overloaded" status. */
const OVERLOAD_STATUSES: ReadonlySet<number> = new Set([503, 529]);

const HTML_BODY = /<html|<!doctype/i;

/** IMF-fixdate (RFC 9110 5.6.7), the only HTTP date form senders generate today. */
const HTTP_DATE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT/;
/** delay-seconds; decimals are not standard but some relays send them. */
const DELAY_SECONDS = /^(\d+(?:\.\d+)?)\s*(?:,|$)/;

/**
 * `retry-after` as milliseconds from `now`: delay-seconds or an HTTP date. Repeated
 * headers arrive joined with `, `; the first value counts. Anything unreadable, or a
 * negative delay, is ignored; a date already past means "now".
 */
export function retryAfterMs(value: string | undefined, now: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  const seconds = DELAY_SECONDS.exec(trimmed);
  if (seconds !== null) {
    const ms = Math.round(Number(seconds[1]) * 1000);
    return Number.isFinite(ms) ? ms : undefined;
  }
  const date = HTTP_DATE.exec(trimmed);
  if (date === null) {
    return undefined;
  }
  const at = Date.parse(date[0]);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function keptText(text: string): string | undefined {
  const kept = sanitizeUpstreamText(text).slice(0, UPSTREAM_MESSAGE_MAX_CHARS);
  return kept === "" ? undefined : kept;
}

function codeOf(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === "string" ? keptText(value) : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? keptText(value) : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Evidence as read, where an absent field may still be spelled out as `undefined`. */
type LooseEvidence = { [K in keyof UpstreamErrorEvidence]: UpstreamErrorEvidence[K] | undefined };

function defined(fields: LooseEvidence): UpstreamErrorEvidence {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as unknown as UpstreamErrorEvidence;
}

/**
 * Reads the fixed evidence fields of an error answer, without recursing into anything
 * else: the documented `{ error: { code, type, message, details: { error_code } } }`
 * shape, relays' top-level `{ code, error_code, message, msg }` (when `error` is absent
 * or a plain string), or, for a body that is not JSON, its text as the message.
 */
export function readUpstreamError(status: number, body: string, headers?: ReadonlyMap<string, string>, now: number = Date.now()): UpstreamErrorEvidence {
  const retryAfter = retryAfterMs(headers?.get("retry-after"), now);
  const base: UpstreamErrorEvidence = { status, ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }) };
  const trimmed = body.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    if (trimmed.startsWith("<") || HTML_BODY.test(trimmed)) {
      return { ...base, message: HTML_PAGE_PLACEHOLDER };
    }
    return defined({ ...base, message: keptText(trimmed) });
  }
  if (typeof parsed === "string") {
    return defined({ ...base, message: keptText(parsed) });
  }
  const record = recordOf(parsed);
  if (record === undefined) {
    return base;
  }
  const inner = recordOf(record["error"]);
  if (inner !== undefined) {
    return defined({
      ...base,
      code: codeOf(inner["code"]),
      detailsCode: codeOf(recordOf(inner["details"])?.["error_code"]),
      type: stringOf(inner["type"]),
      message: stringOf(inner["message"]),
    });
  }
  return defined({
    ...base,
    topCode: codeOf(record["code"]),
    topErrorCode: codeOf(record["error_code"]),
    message: stringOf(record["error"]) ?? stringOf(record["message"]) ?? stringOf(record["msg"]),
  });
}

/** Every code-like field present, in the order they are most specific. */
export function evidenceCodes(evidence: UpstreamErrorEvidence): string[] {
  return [evidence.detailsCode, evidence.code, evidence.type, evidence.topErrorCode, evidence.topCode].filter(
    (code): code is string => code !== undefined,
  );
}

function hasCode(evidence: UpstreamErrorEvidence, codes: ReadonlySet<string>): boolean {
  return evidenceCodes(evidence).some((code) => codes.has(code.toLowerCase()));
}

/**
 * The limit an error answer reports, if any; first match wins. Undefined
 * leaves the answer to the adapter's own rules (auth, model, context length, ...).
 */
export function classifyLimit(evidence: UpstreamErrorEvidence): LimitVerdict | undefined {
  const message = evidence.message ?? "";
  const { status } = evidence;
  if (hasCode(evidence, QUOTA_CODES)) {
    return { kind: "quota", evidence: "quota_code" };
  }
  if (status === PAYMENT_REQUIRED_STATUS) {
    return { kind: "quota", evidence: "status_402" };
  }
  if (QUOTA_TEXT.test(message)) {
    return { kind: "quota", evidence: "quota_text" };
  }
  if (hasCode(evidence, OVERLOAD_CODES)) {
    return { kind: "overloaded", evidence: "overload_code" };
  }
  if (hasCode(evidence, RATE_CODES)) {
    return { kind: "rate_limited", evidence: "rate_code" };
  }
  if (RATE_TEXT.test(message)) {
    return { kind: "rate_limited", evidence: "rate_text" };
  }
  if (OVERLOAD_TEXT.test(message)) {
    return { kind: "overloaded", evidence: "overload_text" };
  }
  if (status === RATE_LIMITED_STATUS) {
    return evidence.retryAfterMs === undefined ? { kind: "limit_ambiguous", evidence: "status_429" } : { kind: "rate_limited", evidence: "retry_after" };
  }
  if (OVERLOAD_STATUSES.has(status)) {
    return { kind: "overloaded", evidence: "status_overload" };
  }
  return undefined;
}

/** `code: message` of the answer, capped; undefined when it said nothing usable. */
export function upstreamMessage(evidence: UpstreamErrorEvidence): string | undefined {
  const text = [evidenceCodes(evidence)[0], evidence.message]
    .filter((part) => part !== undefined)
    .join(": ")
    .slice(0, UPSTREAM_MESSAGE_MAX_CHARS);
  return text === "" ? undefined : text;
}

/** The `upstreamMessage` option of an error built from this evidence. */
export function upstreamOptions(evidence: UpstreamErrorEvidence): AppErrorOptions {
  const text = upstreamMessage(evidence);
  return text === undefined ? {} : { upstreamMessage: text };
}

/**
 * Internal log text: who answered which status with which codes, and the evidence tag.
 * Codes are machine fields; the upstream message never goes in.
 */
export function internalMessage(prefix: string, evidence: UpstreamErrorEvidence, tag: string): string {
  const codes = evidenceCodes(evidence);
  return `${prefix} answered HTTP ${evidence.status}${codes.length === 0 ? "" : ` (${codes.join(", ")})`} evidence=${tag}`;
}

/** The AmberError for a limit verdict. */
export function limitError(verdict: LimitVerdict, evidence: UpstreamErrorEvidence, prefix: string): AmberError {
  const internal = internalMessage(prefix, evidence, verdict.evidence);
  const options = upstreamOptions(evidence);
  const retryAfter = evidence.retryAfterMs;
  switch (verdict.kind) {
    case "quota":
      return amberError("llm_failed", internal, { ...options, code: "llm_failed.quota" });
    case "overloaded":
      return amberError("llm_failed", internal, {
        ...options,
        code: "llm_failed.overloaded",
        ...(retryAfter === undefined ? {} : { details: { retryAfterMs: retryAfter } }),
      });
    case "rate_limited":
      return retryAfter === undefined
        ? amberError("llm_rate_limited", internal, options)
        : amberError("llm_rate_limited", internal, { ...options, code: "llm_rate_limited.retry_after", details: { retryAfterMs: retryAfter } });
    case "limit_ambiguous":
      return amberError("llm_failed", internal, { ...options, code: "llm_failed.limit_ambiguous" });
  }
}
