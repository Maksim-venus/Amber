import type { MediaAssetKind } from "../../shared/enums.ts";
import type { UploadRetentionPolicy } from "../../shared/enums.ts";

export const RETENTION_POLICIES = ["never_delete", "keep", "discard_after_audio", "evictable", "ephemeral"] as const;
export type RetentionPolicy = (typeof RETENTION_POLICIES)[number];

/**
 * Invariant: five lifecycles that never mix. Originals the user
 * handed to Amber are kept, platform caches may be evicted, intermediates are always
 * cleaned. `external_local` files are only referenced and are never deleted by Amber.
 */
export interface MediaAsset {
  id: string;
  userId: string;
  contentId: string;
  kind: MediaAssetKind;
  /** Owning Task of `extracted_audio` / `temporary` assets (cleaned at its terminal state); absent for every other kind. */
  taskId?: string;
  /**
   * Every kind but `external_local`: the FileStore ref `assets/<userId>/<contentId>/<assetId>`,
   * never the original filename. `external_local`: the absolute path of the user's file.
   */
  storageRef: string;
  /** Original filename, display only. */
  displayName?: string;
  mimeType: string;
  sizeBytes: number;
  durationMs?: number;
  /** Quality tier of a `platform_cache` download. */
  quality?: string;
  /** Content hash used to hint at duplicate local files. */
  fingerprint?: string;
  /** Login level used when a `platform_cache` asset was fetched. */
  acquisition?: "guest" | "authenticated";
  availability: "available" | "missing" | "evicted";
  retentionPolicy: RetentionPolicy;
  createdAt: number;
}

/** A `platform_cache` asset holding a video (a Content has at most one video and one audio cache). */
export function isVideoCache(asset: Pick<MediaAsset, "kind" | "mimeType">): boolean {
  return asset.kind === "platform_cache" && asset.mimeType.startsWith("video/");
}

/** A `platform_cache` asset holding audio only. */
export function isAudioCache(asset: Pick<MediaAsset, "kind" | "mimeType">): boolean {
  return asset.kind === "platform_cache" && asset.mimeType.startsWith("audio/");
}

/**
 * Retention per kind at creation. `managed_upload` follows the instance setting in effect
 * when the file arrives; a later settings change does not rewrite
 * existing assets. `extracted_audio` and `temporary` are ephemeral and are cleaned when
 * their owning Task reaches a terminal state, not per stage, because audio-assisted
 * proofreading after ASR still needs the audio.
 */
export function defaultRetentionPolicy(kind: MediaAssetKind, uploadRetentionDefault: UploadRetentionPolicy): RetentionPolicy {
  switch (kind) {
    case "external_local":
      return "never_delete";
    case "managed_upload":
      return uploadRetentionDefault;
    case "platform_cache":
      return "evictable";
    case "extracted_audio":
    case "temporary":
      return "ephemeral";
  }
}
