import { describe, expect, it } from "vitest";
import { parseYoutubeUrl, playlistUrl, watchUrl } from "../../../../../src/server/adapters/platform/youtube/url.ts";

const ID = "dQw4w9WgXcQ";
const WATCH = `https://www.youtube.com/watch?v=${ID}`;

describe("parseYoutubeUrl", () => {
  it("accepts watch and youtu.be links as single videos, even with a list", () => {
    for (const url of [
      WATCH,
      `http://youtube.com/watch?v=${ID}&t=42s`,
      `https://m.youtube.com/watch?v=${ID}`,
      `https://youtu.be/${ID}?si=abc&t=3`,
      `https://www.youtube.com/watch?v=${ID}&list=PLabcdefghij&index=2`,
    ]) {
      expect(parseYoutubeUrl(url), url).toEqual({ platformContentId: ID, canonicalUrl: WATCH });
    }
  });

  it("accepts playlists", () => {
    expect(parseYoutubeUrl("https://www.youtube.com/playlist?list=PLabcdefghij")).toEqual({
      platformCollectionId: "PLabcdefghij",
      canonicalUrl: "https://www.youtube.com/playlist?list=PLabcdefghij",
    });
  });

  it("rejects shorts, channels, malformed ids and other hosts", () => {
    for (const url of [
      "not a url",
      `ftp://www.youtube.com/watch?v=${ID}`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/embed/${ID}`,
      "https://www.youtube.com/@channel",
      "https://www.youtube.com/watch?v=short",
      "https://www.youtube.com/watch",
      `https://youtu.be/${ID}/extra`,
      "https://www.youtube.com/playlist?list=PL",
      "https://www.youtube.com/playlist",
      `https://youtube.com.evil.example/watch?v=${ID}`,
      `https://music.youtube.com/watch?v=${ID}`,
    ]) {
      expect(parseYoutubeUrl(url), url).toBeNull();
    }
  });

  it("builds canonical URLs", () => {
    expect(watchUrl(ID)).toBe(WATCH);
    expect(playlistUrl("PLabcdefghij")).toBe("https://www.youtube.com/playlist?list=PLabcdefghij");
  });
});
