import { describe, expect, it } from "vitest";
import { errorDetail, httpError, rejectsFeature } from "../../../../../src/server/adapters/llm/anthropic-messages/errors.ts";

const body = (type: string, message: string): string => JSON.stringify({ type: "error", error: { type, message } });

describe("anthropic-messages errors", () => {
  it("reads the documented error shape and the OpenAI shape relays sometimes answer with", () => {
    expect(errorDetail(body("rate_limit_error", "slow down"))).toEqual({ type: "rate_limit_error", message: "slow down" });
    expect(errorDetail(JSON.stringify({ error: { code: "model_not_found", message: "no such model" } }))).toEqual({ type: "model_not_found", message: "no such model" });
    expect(errorDetail("<html>bad gateway</html>")).toEqual({});
  });

  it("keeps a placeholder, never the markup, of an HTML page", () => {
    const error = httpError(502, "<html>bad gateway</html>");
    expect(error.appError.code).toBe("llm_failed");
    expect(error.appError.upstreamMessage).toBe("(HTML page)");
  });

  it("reads limits by evidence: 529 and overloaded_error are overload, a quota text beats a 429", () => {
    expect(httpError(529, body("overloaded_error", "Overloaded")).appError).toMatchObject({ code: "llm_failed.overloaded", retryDisposition: "policy" });
    expect(httpError(529, "").appError.code).toBe("llm_failed.overloaded");
    expect(httpError(429, body("rate_limit_error", "Your credit balance is too low")).appError.code).toBe("llm_failed.quota");
    const retry = httpError(429, body("rate_limit_error", "slow down"), new Map([["retry-after", "3"]]));
    expect(retry.appError).toMatchObject({ code: "llm_rate_limited.retry_after", details: { retryAfterMs: 3000 } });
    expect(retry.message).toContain("evidence=rate_code");
  });

  it("keeps the remaining rules: auth, unknown model, server error, context length", () => {
    expect(httpError(400, body("authentication_error", "invalid x-api-key")).appError.code).toBe("llm_failed.auth");
    expect(httpError(400, body("not_found_error", "model: m")).appError.code).toBe("llm_failed.model_not_found");
    expect(httpError(400, body("api_error", "internal")).appError.code).toBe("llm_failed");
    expect(httpError(400, body("invalid_request_error", "prompt is too long: 215000 tokens > 200000 maximum")).appError.code).toBe("llm_capability.context_length");
  });

  it("caps the upstream message", () => {
    const error = httpError(400, body("invalid_request_error", "x".repeat(1000)));
    expect(error.appError.upstreamMessage?.length).toBeLessThanOrEqual(300);
  });

  it("calls a feature unsupported only for a 400 / 422 rejection that names it", () => {
    const unsupported = body("invalid_request_error", "tools: Extra inputs are not permitted");
    expect(rejectsFeature(400, unsupported, "tools")).toBe(true);
    expect(rejectsFeature(422, unsupported, "tools")).toBe(true);
    expect(rejectsFeature(400, unsupported, "structuredOutput")).toBe(false);
    expect(rejectsFeature(500, unsupported, "tools")).toBe(false);
    expect(rejectsFeature(400, body("invalid_request_error", "tools: input_schema is required"), "tools")).toBe(false);
    expect(rejectsFeature(400, body("invalid_request_error", "output_config.format: json_schema is not supported"), "structuredOutput")).toBe(true);
    expect(rejectsFeature(400, body("invalid_request_error", "stream: unsupported parameter"), "stream")).toBe(true);
  });
});
