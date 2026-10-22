import { describe, expect, it } from "vitest";
import { httpError as anthropicHttpError } from "../../../../src/server/adapters/llm/anthropic-messages/errors.ts";
import { httpError as openAiHttpError } from "../../../../src/server/adapters/llm/openai-compatible/errors.ts";
import {
  classifyLimit,
  HTML_PAGE_PLACEHOLDER,
  readUpstreamError,
  retryAfterMs,
  UPSTREAM_MESSAGE_MAX_CHARS,
} from "../../../../src/server/adapters/llm/upstream-error.ts";
import type { AmberError } from "../../../../src/server/domain/errors.ts";

const NOW = Date.parse("2026-10-07T00:00:00Z");

const openAiBody = (error: Record<string, unknown>): string => JSON.stringify({ error });
const anthropicBody = (type: string, message: string, details?: Record<string, unknown>): string =>
  JSON.stringify({ type: "error", error: { type, message, ...(details === undefined ? {} : { details }) } });
const headers = (retryAfter: string): ReadonlyMap<string, string> => new Map([["retry-after", retryAfter]]);

type Classify = (status: number, body: string, headers?: ReadonlyMap<string, string>) => AmberError;
const ADAPTERS: ReadonlyArray<[string, Classify]> = [
  ["openai-compatible", openAiHttpError],
  ["anthropic-messages", anthropicHttpError],
];

describe.each(ADAPTERS)("%s httpError limit evidence", (_, httpError) => {
  it.each([
    ["credit_balance_exhausted", openAiBody({ code: "credit_balance_exhausted", message: "Your credit balance is exhausted" })],
    ["project_spend_limit_exceeded", openAiBody({ code: "project_spend_limit_exceeded", type: "insufficient_quota", message: "limit" })],
    ["organization_usage_limit_exceeded", openAiBody({ code: "organization_usage_limit_exceeded", message: "limit" })],
    ["enforced_spend_limit_reached", anthropicBody("rate_limit_error", "limit", { error_code: "enforced_spend_limit_reached" })],
    ["exceeded_current_quota_error", openAiBody({ type: "exceeded_current_quota_error", message: "Your account is suspended" })],
    ["insufficient_quota, any case", openAiBody({ code: "Insufficient_Quota", message: "x" })],
  ])("429 with the quota code %s is quota", (_name, body) => {
    const error = httpError(429, body);
    expect(error.appError).toMatchObject({ class: "llm_failed", code: "llm_failed.quota", retryDisposition: "never" });
    expect(error.message).toContain("evidence=quota_code");
  });

  it("calls an Anthropic usage-limit 400 quota", () => {
    const body = anthropicBody("invalid_request_error", "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.");
    expect(httpError(400, body).appError.code).toBe("llm_failed.quota");
  });

  it("calls 402 quota whatever the body", () => {
    const error = httpError(402, "");
    expect(error.appError.code).toBe("llm_failed.quota");
    expect(error.message).toContain("evidence=status_402");
  });

  it.each([
    ["a plain-text body", "余额不足，请充值"],
    ["a JSON message", openAiBody({ message: "insufficient balance" })],
    ["a relay's top-level shape", JSON.stringify({ code: 1008, msg: "账户余额不足" })],
    ["a relay's quota wording", JSON.stringify({ error: "用户额度不足, 剩余额度: 0" })],
  ])("calls a 429 with quota wording in %s quota", (_name, body) => {
    const error = httpError(429, body);
    expect(error.appError.code).toBe("llm_failed.quota");
    expect(error.message).toContain("evidence=quota_text");
    expect(error.message).not.toContain("余额");
  });

  it("lets a quota code win over a retry-after header", () => {
    expect(httpError(429, openAiBody({ code: "insufficient_quota", message: "x" }), headers("30")).appError.code).toBe("llm_failed.quota");
  });

  it.each([
    ["Rate limit quota exceeded", openAiBody({ message: "Rate limit quota exceeded" })],
    ["请求过于频繁", "请求过于频繁，请稍后重试"],
    ["too many requests", openAiBody({ message: "Too Many Requests" })],
    ["rate_limit_exceeded", openAiBody({ code: "rate_limit_exceeded", message: "x" })],
    ["TPM wording with 额度", openAiBody({ message: "已达到 TPM 额度上限" })],
  ])("calls a 429 saying %s a rate limit", (_name, body) => {
    const error = httpError(429, body);
    expect(error.appError).toMatchObject({ class: "llm_rate_limited", code: "llm_rate_limited", retryDisposition: "policy" });
    expect(error.appError.details).toBeUndefined();
  });

  it.each([
    ["quota exceeded", openAiBody({ message: "quota exceeded" })],
    ["额度 wording alone", openAiBody({ message: "额度受限，请稍后重试" })],
    ["usage limit alone", openAiBody({ message: "usage limit exceeded" })],
    ["an empty body", ""],
  ])("calls a bare 429 with %s ambiguous", (_name, body) => {
    const error = httpError(429, body);
    expect(error.appError).toMatchObject({ class: "llm_failed", code: "llm_failed.limit_ambiguous", retryDisposition: "never" });
    expect(error.message).toContain("evidence=status_429");
  });

  it("calls a 429 with only a retry-after header a rate limit with its delay", () => {
    const error = httpError(429, "", headers("7"));
    expect(error.appError).toMatchObject({ class: "llm_rate_limited", code: "llm_rate_limited.retry_after", retryDisposition: "policy", details: { retryAfterMs: 7000 } });
    expect(error.message).toContain("evidence=retry_after");
  });

  it.each([
    [429, openAiBody({ type: "engine_overloaded_error", message: "The engine is currently overloaded" })],
    [503, openAiBody({ code: "server_is_overloaded", message: "x" })],
    [503, ""],
    [529, anthropicBody("overloaded_error", "Overloaded")],
    [500, openAiBody({ message: "服务器繁忙，请稍后再试" })],
  ])("calls %i %s overloaded", (status, body) => {
    expect(httpError(status, body).appError).toMatchObject({ class: "llm_failed", code: "llm_failed.overloaded", retryDisposition: "policy" });
  });

  it("keeps the retry-after delay of an overload, and only then", () => {
    expect(httpError(503, "", headers("4")).appError.details).toEqual({ retryAfterMs: 4000 });
    expect(httpError(503, "").appError.details).toBeUndefined();
  });

  it("never keeps an HTML page, caps long text and redacts credentials", () => {
    const html = httpError(429, "<!DOCTYPE html><html><body>429 Too Many Requests sk-abcdefghijklmnop</body></html>");
    expect(html.appError.upstreamMessage).toBe(HTML_PAGE_PLACEHOLDER);
    expect(html.appError.code).toBe("llm_failed.limit_ambiguous");
    expect(httpError(400, "x".repeat(1000)).appError.upstreamMessage).toHaveLength(UPSTREAM_MESSAGE_MAX_CHARS);
    const leaky = httpError(401, openAiBody({ message: "bad header Bearer abc.def for sk-abcdefghijklmnop" }));
    expect(leaky.appError.upstreamMessage).not.toMatch(/abc\.def|abcdefghijklmnop/);
    expect(leaky.message).not.toMatch(/abc\.def|abcdefghijklmnop|bad header/);
  });
});

describe("readUpstreamError", () => {
  it("reads the documented error object, details code included", () => {
    expect(readUpstreamError(429, anthropicBody("rate_limit_error", "m", { error_code: "enforced_spend_limit_reached" }))).toEqual({
      status: 429,
      type: "rate_limit_error",
      detailsCode: "enforced_spend_limit_reached",
      message: "m",
    });
    expect(readUpstreamError(400, openAiBody({ code: 1301, message: "m" }))).toEqual({ status: 400, code: "1301", message: "m" });
  });

  it("reads a relay's top-level code and msg, and a string error as the message", () => {
    expect(readUpstreamError(429, JSON.stringify({ code: 1008, msg: "busy" }))).toEqual({ status: 429, topCode: "1008", message: "busy" });
    expect(readUpstreamError(429, JSON.stringify({ error_code: "E1", error: "out of credit", message: "ignored" }))).toEqual({
      status: 429,
      topErrorCode: "E1",
      message: "out of credit",
    });
  });

  it("ignores top-level fields beside an error object, and nested fields beyond the fixed ones", () => {
    expect(readUpstreamError(429, JSON.stringify({ code: "rate_limit_exceeded", error: { message: "m", meta: { code: "insufficient_quota" } } }))).toEqual({
      status: 429,
      message: "m",
    });
  });

  it("uses trimmed text as the message and a placeholder for HTML", () => {
    expect(readUpstreamError(502, "  upstream down \n")).toEqual({ status: 502, message: "upstream down" });
    expect(readUpstreamError(502, "<h1>Bad gateway</h1>").message).toBe(HTML_PAGE_PLACEHOLDER);
    expect(readUpstreamError(502, "error page <html>").message).toBe(HTML_PAGE_PLACEHOLDER);
    expect(readUpstreamError(502, "   ")).toEqual({ status: 502 });
  });

  it("takes the first retry-after of repeated headers", () => {
    expect(readUpstreamError(429, "", new Map([["retry-after", "3, 9"]]), NOW).retryAfterMs).toBe(3000);
  });
});

describe("retryAfterMs", () => {
  it("reads delay-seconds, decimals included", () => {
    expect(retryAfterMs("7", NOW)).toBe(7000);
    expect(retryAfterMs(" 1.5 ", NOW)).toBe(1500);
    expect(retryAfterMs("0", NOW)).toBe(0);
  });

  it("reads an HTTP date relative to now, a past date as 0", () => {
    expect(retryAfterMs("Wed, 07 Oct 2026 00:00:30 GMT", NOW)).toBe(30_000);
    expect(retryAfterMs("Tue, 06 Oct 2026 23:00:00 GMT", NOW)).toBe(0);
    expect(retryAfterMs("Wed, 07 Oct 2026 00:00:30 GMT, Wed, 07 Oct 2026 00:01:00 GMT", NOW)).toBe(30_000);
  });

  it("ignores garbage, negatives and an absent header", () => {
    expect(retryAfterMs("soon", NOW)).toBeUndefined();
    expect(retryAfterMs("-5", NOW)).toBeUndefined();
    expect(retryAfterMs("7 apples", NOW)).toBeUndefined();
    expect(retryAfterMs("", NOW)).toBeUndefined();
    expect(retryAfterMs(undefined, NOW)).toBeUndefined();
  });
});

describe("classifyLimit", () => {
  it("leaves answers without limit evidence to the adapter", () => {
    expect(classifyLimit({ status: 400, message: "Invalid value for 'messages[0].role'." })).toBeUndefined();
    expect(classifyLimit({ status: 401 })).toBeUndefined();
    expect(classifyLimit({ status: 500 })).toBeUndefined();
  });

  it("tries codes before wording and wording before statuses", () => {
    expect(classifyLimit({ status: 429, code: "rate_limit_exceeded", message: "余额不足" })).toEqual({ kind: "quota", evidence: "quota_text" });
    expect(classifyLimit({ status: 429, code: "overloaded_error", message: "rate limit" })).toEqual({ kind: "overloaded", evidence: "overload_code" });
    expect(classifyLimit({ status: 503, message: "too many requests" })).toEqual({ kind: "rate_limited", evidence: "rate_text" });
    expect(classifyLimit({ status: 429, message: "server is busy" })).toEqual({ kind: "overloaded", evidence: "overload_text" });
  });
});
