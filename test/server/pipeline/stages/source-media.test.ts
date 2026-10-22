import { afterEach, describe, expect, it } from "vitest";
import type { MediaAsset } from "../../../../src/server/domain/media-asset.ts";
import { availableMediaSource, availableVideoSource } from "../../../../src/server/pipeline/stages/source-media.ts";
import { createHarness, createLocalContent, LOCAL, type Harness } from "../../../fixtures/pipeline/harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

function setup() {
  const h = createHarness();
  harnesses.push(h);
  const contentId = createLocalContent(h);
  const add = (fields: Partial<MediaAsset> & Pick<MediaAsset, "kind" | "mimeType" | "createdAt">): MediaAsset => {
    const id = h.newId();
    const asset: MediaAsset = {
      id,
      userId: LOCAL.userId,
      contentId,
      storageRef: `media/${id}`,
      sizeBytes: 1,
      availability: "available",
      retentionPolicy: fields.kind === "platform_cache" ? "evictable" : "keep",
      ...fields,
    };
    h.repository.withTransaction((scope) => scope.mediaAssets.insert(asset));
    return asset;
  };
  const pick = (choose: typeof availableMediaSource) => h.repository.withTransaction((scope) => choose(scope, LOCAL.userId, contentId))?.id;
  return { add, pick };
}

describe("availableVideoSource / availableMediaSource", () => {
  it("prefer the original, then the latest video cache; only audio work falls back to an audio cache", () => {
    const { add, pick } = setup();
    const audio = add({ kind: "platform_cache", mimeType: "audio/mpeg", createdAt: 3 });
    expect(pick(availableVideoSource)).toBeUndefined();
    expect(pick(availableMediaSource)).toBe(audio.id);

    add({ kind: "platform_cache", mimeType: "video/mp4", createdAt: 1 });
    const newerVideo = add({ kind: "platform_cache", mimeType: "video/webm", createdAt: 2 });
    add({ kind: "platform_cache", mimeType: "video/mp4", createdAt: 4, availability: "evicted" });
    expect(pick(availableVideoSource)).toBe(newerVideo.id);
    expect(pick(availableMediaSource)).toBe(newerVideo.id);

    const original = add({ kind: "managed_upload", mimeType: "video/mp4", createdAt: 0 });
    expect(pick(availableVideoSource)).toBe(original.id);
    expect(pick(availableMediaSource)).toBe(original.id);
  });
});
