import type { Platform } from "../shared/enums.ts";

/** What a pasted link would import, as far as the client can tell without going online. */
export interface RecognizedLink {
  url: string;
  platform: Platform;
  /** `collection` imports a whole list; `shortlink` is expanded by the server. */
  kind: "video" | "collection" | "shortlink";
  /** A bilibili video link without `p=` may still name a multi-part submission. */
  partChosen: boolean;
}

const BILIBILI_HOSTS = new Set(["www.bilibili.com", "bilibili.com", "m.bilibili.com"]);
const YOUTUBE_HOSTS = new Set(["www.youtube.com", "youtube.com", "m.youtube.com"]);
const BVID = /^\/video\/(BV[0-9A-Za-z]{10})\/?$/;
const BILIBILI_LIST = /^\/\d+\/lists\/\d+\/?$/;
const YOUTUBE_ID = /^[0-9A-Za-z_-]{11}$/;

/**
 * Client-side recognizer for the link shapes the platforms accept. It decides
 * only whether a paste looks like a supported link and whether it is a batch; the server's
 * parser stays authoritative.
 */
export function recognizeLink(text: string): RecognizedLink | undefined {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return undefined;
  }
  const href = text.trim();
  const host = url.hostname.toLowerCase();
  if (BILIBILI_HOSTS.has(host) && BVID.test(url.pathname)) {
    return { url: href, platform: "bilibili", kind: "video", partChosen: url.searchParams.has("p") };
  }
  if (host === "space.bilibili.com" && BILIBILI_LIST.test(url.pathname)) {
    return { url: href, platform: "bilibili", kind: "collection", partChosen: true };
  }
  if (host === "b23.tv" && /^\/[0-9A-Za-z]+\/?$/.test(url.pathname)) {
    return { url: href, platform: "bilibili", kind: "shortlink", partChosen: false };
  }
  if (YOUTUBE_HOSTS.has(host)) {
    const v = url.searchParams.get("v");
    if (url.pathname === "/watch" && v !== null && YOUTUBE_ID.test(v)) {
      return { url: href, platform: "youtube", kind: "video", partChosen: true };
    }
    const list = url.searchParams.get("list");
    if (url.pathname === "/playlist" && list !== null && list !== "") {
      return { url: href, platform: "youtube", kind: "collection", partChosen: true };
    }
  }
  if (host === "youtu.be" && YOUTUBE_ID.test(url.pathname.slice(1).replace(/\/$/, ""))) {
    return { url: href, platform: "youtube", kind: "video", partChosen: true };
  }
  return undefined;
}

/** Non-empty trimmed lines of a pasted block. */
export function linesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Every supported link in a pasted block, in order. */
export function recognizeLinks(text: string): RecognizedLink[] {
  return linesOf(text).flatMap((line) => {
    const link = recognizeLink(line);
    return link === undefined ? [] : [link];
  });
}
