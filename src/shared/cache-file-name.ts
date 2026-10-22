import { CACHE_DIR_NAME } from "./app-identity.ts";
import { CACHE_FILE_NAME_MAX_CHARS } from "./defaults.ts";

/**
 * File names of cached platform media. Shared by the cache
 * dialog's preview and the server, whose result is authoritative. A cache file lies flat in
 * the cache directory as `<stem>.<ext>`; its `storageRef` is `media/<stem>.<ext>`.
 */

/** Extensions a cache file can have, by the container actually produced. */
export const CACHE_EXTENSIONS = ["mp4", "webm", "mp3"] as const;
export type CacheExtension = (typeof CACHE_EXTENSIONS)[number];

/** What the user asked to cache. */
export const CACHE_MEDIA_TYPES = ["video", "audio"] as const;
export type CacheMediaType = (typeof CACHE_MEDIA_TYPES)[number];

/** Suffix of the file `writeAtomic` writes before renaming it into place. */
export const CACHE_PARTIAL_SUFFIX = ".partial";

/**
 * The longest path Win32 accepts without the `\\?\` prefix, excluding the terminating NUL
 * (`MAX_PATH` = 260). Counted in UTF-16 code units, as Windows does.
 */
export const WINDOWS_MAX_PATH_UNITS = 259;

/** The longest tail a stem can get on disk: the longest extension plus the partial suffix. */
const LONGEST_TAIL = `.webm${CACHE_PARTIAL_SUFFIX}`;

/** Characters Windows refuses in a file name. */
const FORBIDDEN = /[<>:"/\\|?*]/gu;
/** C0 / C1 control characters. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;
/** Device names Windows reserves, with or without an extension (`NUL.tar.gz` is `NUL`). */
const RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;
/** Media extensions a user may have typed into the name field; the real one is appended later. */
const TYPED_EXTENSION = /\.(?:mp4|m4v|webm|mkv|mov|avi|flv|mp3|m4a|aac|wav|flac|ogg|oga|opus|wma)$/iu;

function codePoints(text: string): string[] {
  return Array.from(text);
}

function trimEnds(text: string): string {
  return text.replace(/^[\s.]+/u, "").replace(/[\s.]+$/u, "");
}

/** Appends `_` to the part before the first dot when Windows would read the name as a device. */
function unreserve(stem: string): string {
  const dot = stem.indexOf(".");
  const base = dot === -1 ? stem : stem.slice(0, dot);
  if (!RESERVED.test(base.trimEnd())) {
    return stem;
  }
  return dot === -1 ? `${stem}_` : `${base}_${stem.slice(dot)}`;
}

/**
 * The cleaned stem of a user's file name, or `undefined` when nothing usable remains:
 * NFC, no forbidden or control characters, collapsed whitespace, no leading or trailing
 * dots and spaces, no typed media extension, no device name, at most
 * `CACHE_FILE_NAME_MAX_CHARS` code points.
 */
export function sanitizeCacheStem(input: string): string | undefined {
  // Line breaks and tabs separate words; turn them into spaces before control characters go.
  let stem = input.normalize("NFC").replace(/[\t\n\v\f\r]/gu, " ").replace(CONTROL, "").replace(FORBIDDEN, "").replace(/\s+/gu, " ");
  stem = trimEnds(stem);
  stem = trimEnds(stem.replace(TYPED_EXTENSION, ""));
  stem = trimEnds(codePoints(stem).slice(0, CACHE_FILE_NAME_MAX_CHARS).join(""));
  if (stem === "") {
    return undefined;
  }
  return unreserve(stem);
}

/** `stem`, or `stem (n)` for the n-th candidate when the plain name is taken. */
export function numberedStem(stem: string, n: number): string {
  return n <= 1 ? stem : `${stem} (${n})`;
}

/**
 * The n-th candidate stem shortened so that `<dir>\<stem>.webm.partial` stays within
 * `WINDOWS_MAX_PATH_UNITS`; the number suffix is kept whole. `undefined` when not even one
 * character of the stem fits, i.e. the cache directory itself is too long.
 */
export function fittedCacheStem(stem: string, n: number, cacheDir: string): string | undefined {
  const suffix = n <= 1 ? "" : ` (${n})`;
  // One more unit for the `_` a device name may get after truncation.
  const budget = WINDOWS_MAX_PATH_UNITS - cacheDir.length - 1 - suffix.length - LONGEST_TAIL.length - 1;
  const points = codePoints(stem);
  let units = stem.length;
  while (points.length > 0 && units > budget) {
    units -= (points.pop() as string).length;
  }
  const fitted = trimEnds(points.join(""));
  return fitted === "" ? undefined : `${unreserve(fitted)}${suffix}`;
}

/** The storage ref of a cache file. */
export function cacheRef(stem: string, ext: CacheExtension): string {
  return `${CACHE_DIR_NAME}/${stem}.${ext}`;
}

/** Whether `ref` is a flat cache ref (`media/<name>`). */
export function isCacheRef(ref: string): boolean {
  return ref.startsWith(`${CACHE_DIR_NAME}/`) && !ref.slice(CACHE_DIR_NAME.length + 1).includes("/");
}

/** The file name of a cache ref (`media/a.mp4` → `a.mp4`). */
export function cacheFileNameOf(ref: string): string {
  return ref.slice(CACHE_DIR_NAME.length + 1);
}

/** The stem of a cache ref (`media/a.b.mp4` → `a.b`). */
export function cacheStemOf(ref: string): string {
  const name = cacheFileNameOf(ref);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
}

/** The extension a cache file gets for the container actually produced. */
export function cacheExtensionOf(mimeType: string): CacheExtension | undefined {
  switch (mimeType) {
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
    case "audio/mpeg":
      return "mp3";
    default:
      return undefined;
  }
}

/**
 * Whether `name` is a file name a cache ref may carry: what `sanitizeCacheStem` could have
 * produced plus one of `CACHE_EXTENSIONS`. The store's guard against path traversal.
 */
export function isValidCacheFileName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return false;
  }
  const ext = name.slice(dot + 1);
  if (!(CACHE_EXTENSIONS as readonly string[]).includes(ext)) {
    return false;
  }
  const stem = name.slice(0, dot);
  return (
    stem === stem.normalize("NFC") &&
    !/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/u.test(stem) &&
    trimEnds(stem) === stem &&
    unreserve(stem) === stem &&
    !/\s{2,}|[\t\n\r]/u.test(stem) &&
    name.length <= 255
  );
}
