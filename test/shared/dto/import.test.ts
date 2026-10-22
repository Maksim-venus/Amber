import { describe, expect, it } from "vitest";
import { importRequestSchema, inspectResponseSchema } from "../../../src/shared/dto/import.ts";

describe("importRequestSchema", () => {
  it("defaults autoProofread to true and accepts several items", () => {
    expect(importRequestSchema.parse({ items: [{ url: "https://x" }] })).toEqual({ items: [{ url: "https://x" }], settings: { autoProofread: true } });
    expect(importRequestSchema.safeParse({ items: [{ url: "a" }, { url: "b" }] }).success).toBe(true);
    expect(importRequestSchema.safeParse({ items: [] }).success).toBe(false);
  });

  it("takes a part choice, an initial subtitle and a collection target in the import body", () => {
    const body = {
      items: [
        { url: "a", parts: "all" },
        { url: "b", parts: ["cid-1", "cid-2"] },
        { url: "c", initialSubtitle: { text: "WEBVTT\n", format: "vtt", language: "zh-CN" } },
      ],
      collection: { name: "课程" },
    };
    expect(importRequestSchema.safeParse(body).success).toBe(true);
    expect(importRequestSchema.safeParse({ items: [{ url: "a" }], collection: { id: "c1" } }).success).toBe(true);
    expect(importRequestSchema.safeParse({ items: [{ url: "a", parts: "some" }] }).success).toBe(false);
    expect(importRequestSchema.safeParse({ items: [{ url: "a", parts: [] }] }).success).toBe(false);
    expect(importRequestSchema.safeParse({ items: [{ url: "a", initialSubtitle: { text: "x" } }] }).success).toBe(false);
    expect(importRequestSchema.safeParse({ items: [{ url: "a" }], collection: { id: "c1", name: "both" } }).success).toBe(false);
  });

  it("rejects unknown fields and malformed settings", () => {
    expect(importRequestSchema.safeParse({ items: [{ url: "a" }], other: 1 }).success).toBe(false);
    expect(importRequestSchema.safeParse({ items: [{ url: "a", other: 1 }] }).success).toBe(false);
    expect(importRequestSchema.safeParse({ links: ["a"] }).success).toBe(false);
    expect(importRequestSchema.safeParse({ items: [{ url: "a" }], settings: { modelRef: { providerProfileId: "p" } } }).success).toBe(false);
    expect(importRequestSchema.safeParse({ items: [{ url: "a" }], settings: { outputLanguage: "zh-CN" } }).success).toBe(true);
    expect(importRequestSchema.safeParse({ items: [{ url: "a" }], settings: { outputLanguage: "中文" } }).success).toBe(false);
  });
});

describe("inspectResponseSchema", () => {
  it("describes single, multi-part and collection links", () => {
    expect(inspectResponseSchema.safeParse({ kind: "single", canonicalUrl: "u" }).success).toBe(true);
    expect(
      inspectResponseSchema.safeParse({ kind: "multipart", canonicalUrl: "u", parts: [{ platformPartId: "1", index: 1, title: "p1", durationMs: 1000 }] }).success,
    ).toBe(true);
    expect(inspectResponseSchema.safeParse({ kind: "collection", canonicalUrl: "u", title: "t", itemCount: 1, items: [{ platformContentId: "v", canonicalUrl: "w" }] }).success).toBe(true);
    expect(inspectResponseSchema.safeParse({ kind: "playlist", canonicalUrl: "u" }).success).toBe(false);
  });
});
