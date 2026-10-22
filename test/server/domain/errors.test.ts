import { describe, expect, it } from "vitest";
import { AmberError, amberError, appError, isAmberError, sanitizeUpstreamText } from "../../../src/server/domain/errors.ts";
import { appErrorSchema } from "../../../src/shared/errors.ts";

describe("appError", () => {
  it("fills the error class defaults and the i18n message, with the class as code", () => {
    const error = appError("llm_unconfigured");
    expect(error).toEqual({
      class: "llm_unconfigured",
      code: "llm_unconfigured",
      retryDisposition: "never",
      action: "configure_llm",
      userMessage: expect.any(String),
    });
    expect(appErrorSchema.parse(error)).toEqual(error);
  });

  it("interpolates message parameters and accepts only registered refinements of the same class", () => {
    expect(appError("invalid_request", { params: { detail: "title" } }).userMessage).toContain("title");
    expect(appError("internal", { code: "internal.secret_unavailable" }).code).toBe("internal.secret_unavailable");
    expect(() => appError("not_found", { code: "internal.secret_unavailable" })).toThrow(/not a refinement/);
  });

  it("refuses status-only classes", () => {
    expect(() => appError("subtitle_none")).toThrow(/status code/);
    expect(() => appError("cancelled")).toThrow(/status code/);
  });
});

describe("AmberError", () => {
  it("carries the AppError and keeps its internal message separate from the user message", () => {
    const error = amberError("not_found", "content 01J… not found");
    expect(error).toBeInstanceOf(AmberError);
    expect(isAmberError(error)).toBe(true);
    expect(error.message).toBe("content 01J… not found");
    expect(error.appError.class).toBe("not_found");
    expect(isAmberError(new Error("plain"))).toBe(false);
  });
});

describe("refined codes", () => {
  it("apply the registered disposition, action, message and details", () => {
    const auth = appError("llm_failed", { code: "llm_failed.auth" });
    expect(auth).toMatchObject({ code: "llm_failed.auth", retryDisposition: "never", action: "configure_llm" });
    expect(auth.userMessage).not.toBe(appError("llm_failed").userMessage);
    expect(appError("llm_failed").retryDisposition).toBe("policy");

    const duplicate = appError("conflict", { code: "conflict.duplicate_file", details: { duplicateOfContentId: "01J" } });
    expect(duplicate.details).toEqual({ duplicateOfContentId: "01J" });
    expect(appErrorSchema.parse(duplicate)).toEqual(duplicate);
  });

  it("reject details under keys the code did not register", () => {
    expect(() => appError("conflict", { code: "conflict.duplicate_file", details: { path: "/x" } })).toThrow(/does not register/);
    expect(() => appError("conflict", { details: { duplicateOfContentId: "01J" } })).toThrow(/does not register/);
  });
});

describe("sanitizeUpstreamText", () => {
  it("removes bearer tokens, sk- keys and query-string values", () => {
    const text = sanitizeUpstreamText("bad header Authorization: Bearer abc.def-ghi, key sk-abcdefghijklmnop rejected");
    expect(text).not.toContain("abc.def");
    expect(text).not.toContain("abcdefghijklmnop");
    expect(text).toBe("bad header Authorization: Bearer ***, key sk-*** rejected");
    expect(sanitizeUpstreamText("see https://relay.example.com/v1/chat?key=abc123&user=42#top now")).toBe("see https://relay.example.com/v1/chat?key=***&user=***#top now");
    expect(sanitizeUpstreamText("path /v1/models?api_key=zzz")).toBe("path /v1/models?api_key=***");
  });

  it("leaves short sk- words and ordinary questions alone and collapses whitespace", () => {
    expect(sanitizeUpstreamText("ask-me sk-short? yes")).toBe("ask-me sk-short? yes");
    expect(sanitizeUpstreamText("  line one\n\n\tline   two  ")).toBe("line one line two");
  });
});
