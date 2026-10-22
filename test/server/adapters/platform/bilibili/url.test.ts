import { describe, expect, it } from "vitest";
import { collectionUrl, isShortLink, parseBilibiliUrl, videoUrl } from "../../../../../src/server/adapters/platform/bilibili/url.ts";

const BV = "BV1xx411c7mD";

describe("parseBilibiliUrl", () => {
  it("accepts video links with or without a part and canonicalizes them", () => {
    const cases: Array<[string, ReturnType<typeof parseBilibiliUrl>]> = [
      [`https://www.bilibili.com/video/${BV}`, { platformContentId: BV, canonicalUrl: `https://www.bilibili.com/video/${BV}` }],
      [`http://bilibili.com/video/${BV}/?spm_id_from=333.1&vd_source=x`, { platformContentId: BV, canonicalUrl: `https://www.bilibili.com/video/${BV}` }],
      [`https://m.bilibili.com/video/${BV}`, { platformContentId: BV, canonicalUrl: `https://www.bilibili.com/video/${BV}` }],
      [`  https://WWW.BILIBILI.COM/video/${BV}?p=3&t=12  `, { platformContentId: BV, partIndex: 3, canonicalUrl: `https://www.bilibili.com/video/${BV}?p=3` }],
    ];
    for (const [url, expected] of cases) {
      expect(parseBilibiliUrl(url), url).toEqual(expected);
    }
  });

  it("accepts collections and series in the current and older forms", () => {
    const cases: Array<[string, string, string]> = [
      ["https://space.bilibili.com/202224425/lists/8942017", "202224425_8942017", "https://space.bilibili.com/202224425/lists/8942017"],
      ["https://space.bilibili.com/202224425/lists/8942017?type=season", "202224425_8942017", "https://space.bilibili.com/202224425/lists/8942017"],
      ["https://space.bilibili.com/1/lists/77?type=series", "1_series_77", "https://space.bilibili.com/1/lists/77?type=series"],
      ["https://space.bilibili.com/1/channel/collectiondetail?sid=5", "1_5", "https://space.bilibili.com/1/lists/5"],
      ["https://space.bilibili.com/1/channel/seriesdetail?sid=6", "1_series_6", "https://space.bilibili.com/1/lists/6?type=series"],
    ];
    for (const [url, platformCollectionId, canonicalUrl] of cases) {
      expect(parseBilibiliUrl(url), url).toEqual({ platformCollectionId, canonicalUrl });
    }
  });

  it("rejects everything else", () => {
    for (const url of [
      "not a url",
      `ftp://www.bilibili.com/video/${BV}`,
      "https://www.bilibili.com/video/av170001",
      "https://www.bilibili.com/video/BV1xx411c7m",
      `https://www.bilibili.com/video/${BV}?p=0`,
      `https://www.bilibili.com/video/${BV}?p=abc`,
      `https://www.bilibili.com/bangumi/play/ep1`,
      `https://www.bilibili.com/video/${BV}/extra`,
      `https://evil.example/video/${BV}`,
      `https://bilibili.com.evil.example/video/${BV}`,
      "https://space.bilibili.com/abc/lists/1",
      "https://space.bilibili.com/1/lists/x",
      "https://space.bilibili.com/1/channel/collectiondetail",
      "https://space.bilibili.com/1/video",
      "https://b23.tv/abc123",
    ]) {
      expect(parseBilibiliUrl(url), url).toBeNull();
    }
  });
});

describe("canonical URLs", () => {
  it("round-trip through the parser", () => {
    expect(videoUrl(BV)).toBe(`https://www.bilibili.com/video/${BV}`);
    expect(videoUrl(BV, 2)).toBe(`https://www.bilibili.com/video/${BV}?p=2`);
    for (const id of ["1_2", "1_series_2"]) {
      expect(parseBilibiliUrl(collectionUrl(id) as string)?.platformCollectionId).toBe(id);
    }
    expect(collectionUrl("1_x")).toBeNull();
    expect(collectionUrl("PLabc")).toBeNull();
  });
});

describe("isShortLink", () => {
  it("recognizes b23.tv only", () => {
    expect(isShortLink("https://b23.tv/abc123")).toBe(true);
    expect(isShortLink("http://B23.TV/abc123")).toBe(true);
    expect(isShortLink(`https://www.bilibili.com/video/${BV}`)).toBe(false);
    expect(isShortLink("https://b23.tv.evil.example/abc")).toBe(false);
    expect(isShortLink("b23.tv/abc")).toBe(false);
  });
});
