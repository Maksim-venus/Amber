import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { HmacFileGrantVerifier } from "../../../src/server/adapters/file-grant/hmac-file-grant.ts";
import { MediaAssetService } from "../../../src/server/application/media-assets.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import type { MediaAsset } from "../../../src/server/domain/media-asset.ts";
import { createLocalContent, createTaskOfKind, LOCAL } from "../../fixtures/pipeline/harness.ts";
import { createMediaStack, type MediaStack } from "../../fixtures/pipeline/media-stack.ts";

const open: MediaStack[] = [];
afterEach(async () => {
  for (const stack of open.splice(0)) await stack.close();
});

async function codeOf(work: () => unknown): Promise<string | undefined> {
  try {
    await work();
  } catch (error) {
    if (isAmberError(error)) return error.appError.code;
    throw error;
  }
  return undefined;
}

describe("MediaAssetService and the trash", () => {
  it("treats the media of a trashed Content as unknown: playback, removal, save grants and the burn products", async () => {
    const s = createMediaStack();
    open.push(s);
    const service = new MediaAssetService({ repository: s.h.repository, media: s.stores, gate: s.h.gate, grants: new HmacFileGrantVerifier(randomBytes(32)) });
    const contentId = createLocalContent(s.h);
    const burnTask = createTaskOfKind(s.h, "burn", {}, { contentId });
    s.h.repository.withTransaction((scope) => scope.tasks.setProjection(LOCAL.userId, burnTask, "succeeded", 2));
    const asset = (id: string, extra: Partial<MediaAsset>): MediaAsset => ({
      id, userId: LOCAL.userId, contentId, kind: "managed_upload", storageRef: `assets/${LOCAL.userId}/${contentId}/${id}`, mimeType: "video/mp4",
      sizeBytes: 4, availability: "available", retentionPolicy: "keep", createdAt: 1, ...extra,
    });
    const upload = asset("01UPLOAD", {});
    const cache = asset("01CACHE", { kind: "platform_cache", storageRef: "media/第一讲.mp4", retentionPolicy: "evictable" });
    const burned = asset("01BURNED", { kind: "temporary", taskId: burnTask, retentionPolicy: "ephemeral" });
    s.h.repository.withTransaction((scope) => [upload, cache, burned].forEach((item) => scope.mediaAssets.insert(item)));
    await s.files.writeAtomic(upload.storageRef, Buffer.from("data"));
    await s.stores.cache.writeAtomic(cache.storageRef, Buffer.from("data"));
    expect(service.listBurnOutputs(LOCAL).map((output) => output.assetId)).toEqual([burned.id]);

    s.h.trash.trash(LOCAL, contentId);
    expect(await codeOf(() => service.playable(LOCAL, upload.id))).toBe("not_found");
    expect(await codeOf(() => service.delete(LOCAL, upload.id))).toBe("not_found");
    expect(await codeOf(() => service.delete(LOCAL, cache.id))).toBe("not_found");
    expect(await codeOf(() => service.saveGrant(LOCAL, cache.id))).toBe("not_found");
    expect(service.listBurnOutputs(LOCAL)).toEqual([]);
    expect(await s.files.stat(upload.storageRef)).toEqual({ sizeBytes: 4 });
    expect(await s.stores.cache.stat(cache.storageRef)).toEqual({ sizeBytes: 4 });
  });
});
