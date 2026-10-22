import { describe, expect, it } from "vitest";
import { backlinkUrl } from "../../../src/server/domain/backlink.ts";

describe("backlinkUrl", () => {
  it("sets t in whole seconds on a bilibili URL and keeps p=", () => {
    expect(backlinkUrl({ kind: "bilibili", sourceUrl: "https://www.bilibili.com/video/BV1x?p=2" }, 120_900)).toBe(
      "https://www.bilibili.com/video/BV1x?p=2&t=120",
    );
  });

  it("replaces an existing t and uses the s suffix on YouTube", () => {
    expect(backlinkUrl({ kind: "youtube", sourceUrl: "https://www.youtube.com/watch?v=abc&t=5s" }, 61_000)).toBe(
      "https://www.youtube.com/watch?v=abc&t=61s",
    );
  });

  it("gives local files no link", () => {
    expect(backlinkUrl({ kind: "local" }, 1000)).toBeUndefined();
  });
});
