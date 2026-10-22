import { amberError, sanitizeUpstreamText, type AmberError } from "../../../domain/errors.ts";
import type { LlmProbeFlag } from "../../../ports/llm-provider.ts";
import { classifyLimit, evidenceCodes, internalMessage, limitError, readUpstreamError, UPSTREAM_MESSAGE_MAX_CHARS, upstreamOptions } from "../upstream-error.ts";

interface ErrorDetail {
  type?: string;
  message?: string;
}

/**
 * The `error` object of an error body: `{ type: "error", error: { type, message } }`.
 * Relays sometimes answer in the OpenAI shape `{ error: { type, code, message } }`; the
 * same fields are read from it.
 */
export function errorDetail(body: string): ErrorDetail {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    const error = parsed.error;
    if (typeof error === "object" && error !== null) {
      const record = error as Record<string, unknown>;
      const type = typeof record["type"] === "string" ? record["type"] : typeof record["code"] === "string" ? record["code"] : undefined;
      const message = typeof record["message"] === "string" ? record["message"] : undefined;
      return { ...(type === undefined ? {} : { type }), ...(message === undefined ? {} : { message }) };
    }
  } catch {
    // Not JSON: nothing is kept from it.
  }
  return {};
}

/** `type: message`, capped; what an error may carry of the upstream answer. */
export function upstreamText(detail: ErrorDetail): string | undefined {
  const text = sanitizeUpstreamText([detail.type, detail.message].filter((part) => part !== undefined).join(": ")).slice(0, UPSTREAM_MESSAGE_MAX_CHARS);
  return text === "" ? undefined : text;
}

const PREFIX = "messages API";
const CONTEXT_LENGTH = /prompt is too long|context (window|length)|too many (input )?tokens|exceeds? .*(context|max(imum)?)/i;
const AUTH_TYPES: ReadonlySet<string> = new Set(["authentication_error", "permission_error"]);

/**
 * An HTTP error answer as an LLM error class. An error status means the
 * request was refused, not processed, so none of these is `outcome_unknown`. Limits
 * (quota, rate, overload, including 529) are read by the shared evidence tiers first;
 * server errors retry by policy, everything else needs the user.
 */
export function httpError(status: number, body: string, headers?: ReadonlyMap<string, string>): AmberError {
  const evidence = readUpstreamError(status, body, headers);
  const limit = classifyLimit(evidence);
  if (limit !== undefined) {
    return limitError(limit, evidence, PREFIX);
  }
  const options = upstreamOptions(evidence);
  const codes = evidenceCodes(evidence);
  if (status === 401 || status === 403 || codes.some((code) => AUTH_TYPES.has(code))) {
    return amberError("llm_failed", internalMessage(PREFIX, evidence, "auth"), { ...options, code: "llm_failed.auth" });
  }
  if (status === 404 || codes.includes("not_found_error")) {
    return amberError("llm_failed", internalMessage(PREFIX, evidence, "not_found"), { ...options, code: "llm_failed.model_not_found" });
  }
  if (status >= 500 || codes.includes("api_error")) {
    return amberError("llm_failed", internalMessage(PREFIX, evidence, "server_error"), options);
  }
  if (CONTEXT_LENGTH.test(evidence.message ?? "")) {
    return amberError("llm_capability", internalMessage(PREFIX, evidence, "context_length"), { ...options, code: "llm_capability.context_length" });
  }
  return amberError("llm_failed", internalMessage(PREFIX, evidence, "invalid_request"), { ...options, code: "llm_failed.invalid_request" });
}

/** Words of an upstream refusal that names something as unsupported or unknown. */
const REJECTION = /not supported|unsupported|does not support|not permitted|extra inputs|unknown (parameter|field|argument)|unrecognized|not available|unavailable/i;

/** What a rejection must mention to be about the probed feature and not something else. */
const FEATURE: Record<LlmProbeFlag, RegExp> = {
  stream: /\bstream/i,
  structuredOutput: /output_config|output_format|json_schema|structured output/i,
  tools: /\btools?\b|tool_choice|tool use/i,
};

/**
 * Whether an error answer explicitly says the probed parameter or feature is unsupported;
 * only then does "test connection" record `unsupported`.
 */
export function rejectsFeature(status: number, body: string, flag: LlmProbeFlag): boolean {
  if (status !== 400 && status !== 422) {
    return false;
  }
  const message = errorDetail(body).message ?? "";
  return REJECTION.test(message) && FEATURE[flag].test(message);
}
