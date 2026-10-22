import { describe, expect, it, vi } from "vitest";
import type { MediaAssetDto } from "../../../src/shared/dto/content.ts";
import { ApiClient } from "../../../src/web/api/client.ts";
import { localPlayable, mediaUrlOf, playableCache, playableCaches, playbackAsset } from "../../../src/web/player/media-url.ts";

vi.mock("../../../src/web/desktop/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("../../fixtures/web/desktop-bridge.ts")).fakeBridge,
}));

function asset(id: string, overrides: Partial<MediaAssetDto>): MediaAssetDto {
  return { id, kind: "external_local", mimeType: "video/mp4", sizeBytes: 1, availability: "available", retentionPolicy: "never_delete", createdAt: 1, ...overrides };
}

describe("mediaUrlOf", () => {
  it("serves uploads and caches over /api/media in server mode and never reads local paths there", async () => {
    const server = new ApiClient({ baseUrl: "" }, "server");
    const media = [asset("a1", { kind: "managed_upload", retentionPolicy: "keep" })];
    expect(await mediaUrlOf({ media }, server, false)).toBe("/api/media/a1");
    expect(await mediaUrlOf({ media: [asset("a2", { localPath: "/data/a.mp4" })] }, server, true)).toBeUndefined();
  });

  it("plays the local original or the platform cache through the asset protocol in the desktop client", async () => {
    const local = new ApiClient({ baseUrl: "http://127.0.0.1:1", token: "t" }, "local");
    const original = asset("a1", { localPath: "D:\\课程\\第一讲.mp4" });
    expect(await mediaUrlOf({ media: [original] }, local, true)).toBe(`asset://localhost/${encodeURIComponent("D:\\课程\\第一讲.mp4")}`);
    const cache = asset("c1", { kind: "platform_cache", retentionPolicy: "evictable", localPath: "/data/assets/c1.mp4" });
    expect(await mediaUrlOf({ media: [cache] }, local, true)).toBe(`asset://localhost/${encodeURIComponent("/data/assets/c1.mp4")}`);
    // Outside the client, missing files and assets without a path have no source.
    expect(await mediaUrlOf({ media: [original] }, local, false)).toBeUndefined();
    expect(await mediaUrlOf({ media: [asset("a3", { availability: "missing" })] }, local, true)).toBeUndefined();
    expect(localPlayable({ media: [asset("a4", {})] })).toBeUndefined();
  });

  it("knows when a platform video has a playable cache", () => {
    expect(playableCache({ media: [asset("c1", { kind: "platform_cache", localPath: "/c.mp4" })] })?.asset.id).toBe("c1");
    expect(playableCache({ media: [asset("c1", { kind: "platform_cache", availability: "evicted", localPath: "/c.mp4" })] })).toBeUndefined();
    expect(playableCache({ media: [asset("a1", { localPath: "/a.mp4" })] })).toBeUndefined();
  });

  it("prefers the video cache to the audio cache and flags an audio-only cache", () => {
    const video = asset("v1", { kind: "platform_cache", mimeType: "video/webm", retentionPolicy: "evictable", localPath: "D:\\media\\课程.webm" });
    const audio = asset("m1", { kind: "platform_cache", mimeType: "audio/mpeg", retentionPolicy: "evictable", localPath: "D:\\media\\课程.mp3" });
    // Order in the list does not matter: the video always wins.
    expect(playableCache({ media: [audio, video] })).toEqual({ asset: video, audioOnly: false });
    expect(playableCaches({ media: [audio, video] }).map((item) => item.id)).toEqual(["v1", "m1"]);
    expect(localPlayable({ media: [audio, video] })?.id).toBe("v1");
    expect(playableCache({ media: [audio] })).toEqual({ asset: audio, audioOnly: true });
    expect(localPlayable({ media: [audio] })?.id).toBe("m1");
    expect(playbackAsset({ media: [audio] }, "local", true)?.mimeType).toBe("audio/mpeg");
    expect(playbackAsset({ media: [audio] }, "local", false)).toBeUndefined();
  });

  it("keeps a local original ahead of any cache", () => {
    const audio = asset("m1", { kind: "platform_cache", mimeType: "audio/mpeg", retentionPolicy: "evictable", localPath: "/c.mp3" });
    const original = asset("a1", { localPath: "/a.mp4" });
    expect(localPlayable({ media: [audio, original] })?.id).toBe("a1");
  });
});
