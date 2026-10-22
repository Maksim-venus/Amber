import { useEffect, useState } from "react";
import type { ContentDetailDto, MediaAssetDto } from "../../shared/dto/content.ts";
import type { ApiClient } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { localFileUrl } from "../desktop/bridge.ts";
import { useDesktop } from "../desktop/use-desktop.ts";

/** Kinds `GET /api/media/:assetId` serves (server mode). */
const SERVED_KINDS = new Set(["managed_upload", "platform_cache"]);

type Media = Pick<ContentDetailDto, "media">;

/** An available asset with the path the backend reported for the desktop client. */
export type LocalAsset = MediaAssetDto & { localPath: string };

function isLocal(item: MediaAssetDto): item is LocalAsset {
  return item.availability === "available" && item.localPath !== undefined;
}

/** Whether an asset carries sound only; caches are told apart by their MIME prefix. */
export function isAudioOnly(asset: Pick<MediaAssetDto, "mimeType">): boolean {
  return asset.mimeType.startsWith("audio/");
}

/**
 * The platform caches the desktop client can read, the video before the audio. A Content
 * holds at most one of each.
 */
export function playableCaches(content: Media): LocalAsset[] {
  const caches = content.media.filter((item): item is LocalAsset => item.kind === "platform_cache" && isLocal(item));
  const video = caches.find((item) => item.mimeType.startsWith("video/"));
  const audio = caches.find((item) => isAudioOnly(item));
  return [video, audio].filter((item): item is LocalAsset => item !== undefined);
}

/**
 * The cache the local player switches to: the video cache when there is one, else the
 * audio cache, which plays without a picture (`audioOnly`).
 */
export function playableCache(content: Media): { asset: LocalAsset; audioOnly: boolean } | undefined {
  const asset = playableCaches(content)[0];
  return asset === undefined ? undefined : { asset, audioOnly: isAudioOnly(asset) };
}

/** The file the desktop client plays: a local original first, then the best platform cache. */
export function localPlayable(content: Media): LocalAsset | undefined {
  return content.media.find((item): item is LocalAsset => item.kind === "external_local" && isLocal(item)) ?? playableCache(content)?.asset;
}

/** The asset `mediaUrlOf` streams, or undefined where there is no player source. */
export function playbackAsset(content: Media, mode: ApiClient["mode"], desktop: boolean): MediaAssetDto | undefined {
  if (mode === "server") {
    return content.media.find((item) => SERVED_KINDS.has(item.kind) && item.availability === "available");
  }
  return desktop ? localPlayable(content) : undefined;
}

/**
 * URL the `<video>` player streams from, when there is one. The server mode serves uploads
 * and platform caches over `/api/media`; the desktop client reads the original local file
 * or a platform cache (video before audio) through its asset protocol. A local backend
 * outside the desktop client has no player source.
 */
export async function mediaUrlOf(content: Media, client: Pick<ApiClient, "mode" | "url">, desktop: boolean): Promise<string | undefined> {
  const asset = playbackAsset(content, client.mode, desktop);
  if (asset === undefined) return undefined;
  if (client.mode === "server") return client.url(`/api/media/${encodeURIComponent(asset.id)}`);
  return asset.localPath === undefined ? undefined : localFileUrl(asset.localPath);
}

/**
 * `mediaUrlOf` for a component: `src` is undefined until resolved and whenever there is no
 * source; `audioOnly` says the file has no picture, so the player shows a placeholder.
 */
export function usePlaybackMedia(content: Media): { src: string | undefined; audioOnly: boolean } {
  const client = useApi();
  const desktop = useDesktop();
  const [url, setUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    mediaUrlOf(content, client, desktop).then(
      (next) => {
        if (live) setUrl(next);
      },
      () => {
        if (live) setUrl(undefined);
      },
    );
    return () => {
      live = false;
    };
  }, [content, client, desktop]);
  const asset = playbackAsset(content, client.mode, desktop);
  return { src: url, audioOnly: asset !== undefined && isAudioOnly(asset) };
}
