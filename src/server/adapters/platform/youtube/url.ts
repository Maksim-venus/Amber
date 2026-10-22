import type { ParsedPlatformUrl } from "../../../ports/platform-source.ts";

const WATCH_HOSTS = new Set(["www.youtube.com", "youtube.com", "m.youtube.com"]);
const VIDEO_ID = /^[0-9A-Za-z_-]{11}$/;
const LIST_ID = /^[0-9A-Za-z_-]{10,64}$/;

export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function playlistUrl(listId: string): string {
  return `https://www.youtube.com/playlist?list=${listId}`;
}

/**
 * YouTube URLs Amber accepts: `watch?v=`, `youtu.be/<id>` and
 * `playlist?list=`. A watch URL that also carries `list=` is a single video.
 */
export function parseYoutubeUrl(url: string): ParsedPlatformUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "youtu.be") {
    const id = parsed.pathname.slice(1);
    return VIDEO_ID.test(id) ? { platformContentId: id, canonicalUrl: watchUrl(id) } : null;
  }
  if (!WATCH_HOSTS.has(host)) {
    return null;
  }
  if (parsed.pathname === "/watch") {
    const id = parsed.searchParams.get("v");
    return id !== null && VIDEO_ID.test(id) ? { platformContentId: id, canonicalUrl: watchUrl(id) } : null;
  }
  if (parsed.pathname === "/playlist") {
    const list = parsed.searchParams.get("list");
    return list !== null && LIST_ID.test(list) ? { platformCollectionId: list, canonicalUrl: playlistUrl(list) } : null;
  }
  return null;
}
