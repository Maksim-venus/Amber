import { describe, expect, it } from "vitest";
import { PlatformRegistry } from "../../../src/server/application/platforms.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { FakePlatformAdapter } from "../../fixtures/platform/fake-adapter.ts";

const signal = new AbortController().signal;

function registry() {
  const bilibili = new FakePlatformAdapter("bilibili");
  const youtube = new FakePlatformAdapter("youtube");
  return { bilibili, youtube, registry: new PlatformRegistry([bilibili, youtube]) };
}

describe("PlatformRegistry", () => {
  it("lists the composed adapters and finds one by kind", () => {
    const { bilibili, youtube, registry: platforms } = registry();
    expect(platforms.all).toEqual([bilibili, youtube]);
    expect(platforms.adapterFor("youtube")).toBe(youtube);
    expect(() => new PlatformRegistry([bilibili]).adapterFor("youtube")).toThrow(TypeError);
  });

  it("recognizes supported URLs purely, trimming whitespace, and nothing else", () => {
    const { bilibili, youtube, registry: platforms } = registry();
    expect(platforms.parse("  https://www.bilibili.com/video/BV1xx411c7mD?p=2 \n")).toEqual({
      adapter: bilibili,
      parsed: { platformContentId: "BV1xx411c7mD", partIndex: 2, canonicalUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=2" },
    });
    expect(platforms.parse("https://youtu.be/dQw4w9WgXcQ")?.adapter).toBe(youtube);
    expect(platforms.parse("https://example.com/video/BV1xx411c7mD")).toBeUndefined();
    expect(platforms.parse("not a url")).toBeUndefined();
    expect(bilibili.calls).toEqual([]);
  });

  it("recognizes a direct link without going online", async () => {
    const { bilibili, registry: platforms } = registry();
    const recognized = await platforms.recognize("https://www.bilibili.com/video/BV1xx411c7mD", signal);
    expect(recognized.parsed.platformContentId).toBe("BV1xx411c7mD");
    expect(bilibili.calls).toEqual([]);
  });

  it("expands a short link through the adapter that owns it", async () => {
    const { bilibili, registry: platforms } = registry();
    bilibili.shortLinks.set("https://b23.tv/abc123", "https://www.bilibili.com/video/BV1xx411c7mD?p=3");
    const recognized = await platforms.recognize(" https://b23.tv/abc123 ", signal);
    expect(recognized.adapter).toBe(bilibili);
    expect(recognized.parsed).toMatchObject({ platformContentId: "BV1xx411c7mD", partIndex: 3 });
    expect(bilibili.callsOf("resolveUrl").map((call) => call.target)).toEqual(["https://b23.tv/abc123"]);
  });

  it("answers source_unsupported_url naming the supported platforms, also when a short link leads elsewhere", async () => {
    const { bilibili, registry: platforms } = registry();
    bilibili.shortLinks.set("https://b23.tv/elsewhere", "https://example.com/landing");
    for (const url of ["https://example.com/watch?v=1", "https://b23.tv/elsewhere", "https://b23.tv/unknown"]) {
      const error = await platforms.recognize(url, signal).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(isAmberError(error), url).toBe(true);
      if (isAmberError(error)) {
        expect(error.appError.class).toBe("source_unsupported_url");
        expect(error.appError.userMessage).toContain("bilibili, youtube");
      }
    }
  });
});
