import type { BurnOutputDto } from "../../shared/dto/media.ts";
import type { SaveGrantDto } from "../../shared/dto/local-media.ts";
import { amberError } from "../domain/errors.ts";
import type { MediaAsset } from "../domain/media-asset.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { FileGrantIssuer } from "../ports/file-grant.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import type { CacheGate } from "../pipeline/cache-gate.ts";
import { gateConflict } from "../pipeline/gate-conflict.ts";
import type { MediaFiles } from "../pipeline/media-files.ts";
import { isTerminalProjection } from "../pipeline/projection.ts";
import { displayTitleOf } from "../domain/content.ts";

export interface MediaAssetServiceOptions {
  repository: Repository;
  /** The asset kind decides the store a file is read from or removed in. */
  media: Pick<MediaFiles, "storeFor">;
  /** Removing a cache file holds a shared lease so a cache move never races it. */
  gate: Pick<CacheGate, "tryShared" | "exclusiveReason">;
  /** Local mode only: signs `burn_output` / `cache_save` grants for the shell. */
  grants?: FileGrantIssuer;
}

/** Kinds a browser may stream in server mode. */
const PLAYABLE: ReadonlySet<MediaAsset["kind"]> = new Set(["managed_upload", "platform_cache"]);

/**
 * One of the owner's assets whose Content is outside the trash; an asset of a trashed
 * Content is as unknown as the Content.
 */
export function visibleAsset(scope: RepositoryScope, owner: string, assetId: string): MediaAsset | undefined {
  const asset = scope.mediaAssets.get(owner, assetId);
  return asset === undefined || scope.contents.get(owner, asset.contentId) === undefined ? undefined : asset;
}

export interface PlayableMedia {
  mimeType: string;
  sizeBytes: number;
  read(range?: { start: number; end: number }): AsyncIterable<Uint8Array>;
}

/** Media playback, manual removal and the burn products waiting to be saved. */
export class MediaAssetService {
  private readonly options: MediaAssetServiceOptions;

  constructor(options: MediaAssetServiceOptions) {
    this.options = options;
  }

  /** Only available uploads and caches are served; anything else, or a file gone from disk, is `not_found`. */
  async playable(principal: RequestPrincipal, assetId: string): Promise<PlayableMedia> {
    const asset = this.options.repository.withTransaction((scope) => visibleAsset(scope, principal.userId, assetId));
    if (asset === undefined || !PLAYABLE.has(asset.kind) || asset.availability !== "available") {
      throw amberError("not_found", "media asset is not playable");
    }
    const files = this.options.media.storeFor(asset.kind);
    const stored = await files.stat(asset.storageRef);
    if (stored === null) {
      throw amberError("not_found", "media file is gone");
    }
    return {
      mimeType: asset.mimeType,
      sizeBytes: stored.sizeBytes,
      read: (range) => files.read(asset.storageRef, range),
    };
  }

  /**
   * Per kind: a `platform_cache` file is evicted and its row kept
   * as `evicted`; a `managed_upload` loses file and row; the user's own `external_local`
   * file and Task intermediates are refused, except a `burn` Task's product, which the
   * client removes after saving it. Refused while the Content has an unfinished Task, and
   * for a cache while the cache is being moved (`conflict.cache_migrating`). The database
   * changes first; the file goes after the commit.
   */
  async delete(principal: RequestPrincipal, assetId: string): Promise<void> {
    const owner = principal.userId;
    const kind = this.options.repository.withTransaction((scope) => visibleAsset(scope, owner, assetId)?.kind);
    if (kind === undefined) {
      throw amberError("not_found", "media asset not found");
    }
    const release = kind === "platform_cache" ? this.options.gate.tryShared() : () => undefined;
    if (release === undefined) {
      throw gateConflict(this.options.gate);
    }
    try {
      const removed = this.options.repository.withTransaction((scope) => {
        const asset = visibleAsset(scope, owner, assetId);
        if (asset === undefined) {
          throw amberError("not_found", "media asset not found");
        }
        if (scope.tasks.listByContent(owner, asset.contentId).some((task) => !isTerminalProjection(task.statusProjection))) {
          throw amberError("conflict", "the content has unfinished tasks", { code: "conflict.tasks_unfinished" });
        }
        switch (asset.kind) {
          case "platform_cache":
            scope.mediaAssets.update(owner, { ...asset, availability: "evicted" });
            return asset;
          case "managed_upload":
            scope.mediaAssets.delete(owner, asset.id);
            return asset;
          case "temporary": {
            const task = asset.taskId === undefined ? undefined : scope.tasks.get(owner, asset.taskId);
            if (task?.kind !== "burn") {
              throw amberError("conflict", "task intermediates are removed with their task");
            }
            scope.mediaAssets.delete(owner, asset.id);
            return asset;
          }
          case "extracted_audio":
            throw amberError("conflict", "task intermediates are removed with their task");
          case "external_local":
            throw amberError("conflict", "the user's own files are never deleted by Amber");
        }
      });
      await this.options.media.storeFor(removed.kind).remove(removed.storageRef);
    } finally {
      release();
    }
  }

  /** `GET /api/media/burn-outputs` [client]: burn products not yet saved out, oldest first, none of a trashed Content. */
  listBurnOutputs(principal: RequestPrincipal): BurnOutputDto[] {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) =>
      scope.mediaAssets.listBurnOutputs(owner).flatMap((asset) => {
        const content = scope.contents.get(owner, asset.contentId);
        if (content === undefined) {
          return [];
        }
        const title = displayTitleOf(content);
        return {
          assetId: asset.id,
          contentId: asset.contentId,
          taskId: asset.taskId as string,
          ...(title === undefined ? {} : { title }),
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          createdAt: asset.createdAt,
        };
      }),
    );
  }

  /**
   * `POST /api/media/:assetId/save-grant` [client]: binds the absolute path of one of the
   * user's files to a short-lived grant whose purpose says what it is:
   * an available burn product → `burn_output`, an available `platform_cache` →
   * `cache_save`. The WebView never names a source path; the shell copies only what such
   * a grant covers and checks that the purpose matches the command. Anything else is
   * `conflict`.
   */
  saveGrant(principal: RequestPrincipal, assetId: string): SaveGrantDto {
    const grants = this.options.grants;
    if (grants === undefined) {
      throw new TypeError("save grants exist only in local mode");
    }
    const owner = principal.userId;
    const { asset, purpose } = this.options.repository.withTransaction((scope) => {
      const found = visibleAsset(scope, owner, assetId);
      if (found === undefined) {
        throw amberError("not_found", "media asset not found");
      }
      if (found.availability === "available" && found.kind === "platform_cache") {
        return { asset: found, purpose: "cache_save" as const };
      }
      const task = found.taskId === undefined ? undefined : scope.tasks.get(owner, found.taskId);
      if (found.availability === "available" && found.kind === "temporary" && task?.kind === "burn") {
        return { asset: found, purpose: "burn_output" as const };
      }
      throw amberError("conflict", "only an available burn product or media cache can be saved");
    });
    return { grant: grants.issue({ path: this.options.media.storeFor(asset.kind).pathOf(asset.storageRef), purpose }) };
  }
}
