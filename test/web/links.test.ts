import { describe, expect, it } from "vitest";
import { linesOf, recognizeLink, recognizeLinks } from "../../src/web/links.ts";

describe("recognizeLink", () => {
  it.each([
    ["https://www.bilibili.com/video/BV1CQt365EzW", { platform: "bilibili", kind: "video", partChosen: false }],
    ["https://www.bilibili.com/video/BV1CQt365EzW/?p=3", { platform: "bilibili", kind: "video", partChosen: true }],
    ["https://space.bilibili.com/123/lists/456", { platform: "bilibili", kind: "collection" }],
    ["https://b23.tv/abc123", { platform: "bilibili", kind: "shortlink" }],
    ["https://www.youtube.com/watch?v=UF8uR6Z6KLc", { platform: "youtube", kind: "video" }],
    ["https://www.youtube.com/watch?v=UF8uR6Z6KLc&list=PL1", { platform: "youtube", kind: "video" }],
    ["https://youtu.be/UF8uR6Z6KLc", { platform: "youtube", kind: "video" }],
    ["https://www.youtube.com/playlist?list=PL123", { platform: "youtube", kind: "collection" }],
  ])("accepts %s", (url, expected) => {
    expect(recognizeLink(url)).toMatchObject({ url, ...expected });
  });

  it.each(["https://example.com/watch?v=UF8uR6Z6KLc", "not a url", "ftp://youtu.be/UF8uR6Z6KLc", "https://www.bilibili.com/read/cv1", "https://www.youtube.com/watch?v=short"])(
    "rejects %s",
    (text) => {
      expect(recognizeLink(text)).toBeUndefined();
    },
  );

  it("splits a pasted block into trimmed lines and keeps only supported links", () => {
    const block = "  https://youtu.be/UF8uR6Z6KLc \n\nhello\r\nhttps://b23.tv/x1\n";
    expect(linesOf(block)).toEqual(["https://youtu.be/UF8uR6Z6KLc", "hello", "https://b23.tv/x1"]);
    expect(recognizeLinks(block).map((link) => link.url)).toEqual(["https://youtu.be/UF8uR6Z6KLc", "https://b23.tv/x1"]);
  });
});
