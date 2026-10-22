import { describe, expect, it } from "vitest";
import { isValidIdempotencyKey, jsonRequestDigest, multipartRequestDigest } from "../../../src/server/application/idempotency.ts";

describe("request digests", () => {
  it("ignore key order in JSON bodies and change with any value", () => {
    expect(jsonRequestDigest({ a: 1, b: { c: [1, 2] } })).toBe(jsonRequestDigest({ b: { c: [1, 2] }, a: 1 }));
    expect(jsonRequestDigest({ a: 1 })).not.toBe(jsonRequestDigest({ a: 2 }));
    expect(jsonRequestDigest({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("digest multipart uploads by logical field names and content digests", () => {
    const base = { mediaSha256: "m", metadata: { allowDuplicate: false } };
    expect(multipartRequestDigest(base)).toBe(multipartRequestDigest({ metadata: { allowDuplicate: false }, mediaSha256: "m" }));
    expect(multipartRequestDigest(base)).not.toBe(multipartRequestDigest({ ...base, subtitleSha256: "s" }));
  });

  it("accept visible ASCII keys up to 255 characters", () => {
    expect(isValidIdempotencyKey("0f3c-9a")).toBe(true);
    expect(isValidIdempotencyKey("")).toBe(false);
    expect(isValidIdempotencyKey("has space")).toBe(false);
    expect(isValidIdempotencyKey("x".repeat(256))).toBe(false);
  });
});
