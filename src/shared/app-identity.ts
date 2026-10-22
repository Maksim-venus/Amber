/**
 * Names that identify the desktop client on disk and in the operating system. The shell,
 * the installer hooks and the sidecar all read them from here, so a directory or credential
 * name has a single source. Changing `MASTER_KEY_SERVICE` or
 * `MASTER_KEY_ACCOUNT` would orphan every secret already encrypted under the stored key.
 */

/** The Tauri bundle identifier; also the name of WebView2's own state directory. */
export const APP_IDENTIFIER = "com.lifefindsitsway.amber";

/**
 * The identifier of earlier builds. The shell moves the master key
 * from its credential and removes its WebView2 state directory; the uninstaller deletes both.
 */
export const LEGACY_APP_IDENTIFIER = "io.github.lifefindsitsway.amber";

/** The data directory under `%APPDATA%` (`appDirectoriesOverride.data = $DATA/Amber`). */
export const DATA_DIR_NAME = "Amber";

/** The log directory inside the data directory. */
export const LOG_DIR_NAME = "logs";

/** The cache directory: `<data dir>/media` by default, `<picked dir>/media` when relocated. */
export const CACHE_DIR_NAME = "media";

/**
 * Amber's own subdirectory of the cache directory, part of the cache directory contract: a video
 * download keeps yt-dlp's intermediate files in `<cache dir>/.amber-tmp/<assetId>/`, on the
 * volume of the finished file. It is never a cache file and never counted as one.
 */
export const CACHE_SCRATCH_DIR = ".amber-tmp";

/** Ownership marker of the data directory, written by the shell only (never in server mode). */
export const DATA_ROOT_MARKER = ".amber-data-root";

/** Ownership marker of a relocated cache directory. */
export const CACHE_ROOT_MARKER = ".amber-cache-root";

/** First line of the data directory marker; the second line is `APP_IDENTIFIER` when written. */
export const DATA_ROOT_MARKER_MAGIC = "amber-data-root-v1";

/** First line of a cache directory marker; the second line is `APP_IDENTIFIER` when written. */
export const CACHE_ROOT_MARKER_MAGIC = "amber-cache-root-v1";

/**
 * Registry of every relocated cache directory that still carries `CACHE_ROOT_MARKER`, in
 * the data directory. UTF-16LE with a byte order mark, one absolute path per line, so the
 * NSIS uninstaller can read it with `FileReadUTF16LE`.
 */
export const CACHE_ROOTS_FILE = "cache-roots.txt";

/** The Windows Credential Manager entry of the local master key. */
export const MASTER_KEY_SERVICE = APP_IDENTIFIER;
export const MASTER_KEY_ACCOUNT = "master-key-v1";

/** The generic credential's target name as the keyring crate stores it: `{account}.{service}`. */
export const MASTER_KEY_TARGET = `${MASTER_KEY_ACCOUNT}.${MASTER_KEY_SERVICE}`;

/** The master key credential of earlier builds, named after `LEGACY_APP_IDENTIFIER`. */
export const LEGACY_MASTER_KEY_TARGET = `${MASTER_KEY_ACCOUNT}.${LEGACY_APP_IDENTIFIER}`;

/** The text of an ownership marker. */
export function markerText(magic: string): string {
  return `${magic}\n${APP_IDENTIFIER}\n`;
}

/**
 * Whether `text` is a valid marker with `magic`; trailing whitespace and CRLF are tolerated.
 * Only the first line decides: the second names whichever identifier wrote it, and markers of
 * builds under `LEGACY_APP_IDENTIFIER` must stay valid.
 */
export function isMarkerText(text: string, magic: string): boolean {
  const [first, second] = text.split(/\r?\n/u);
  return first?.trim() === magic && second !== undefined && second.trim() !== "";
}

/** The public source repository; the about dialog links to it. */
export const PUBLIC_REPOSITORY_URL = "https://github.com/lifefindsitsway/Amber";

/** The release list, opened by "手动下载" when the in-app update cannot be used. */
export const RELEASES_PAGE_URL = `${PUBLIC_REPOSITORY_URL}/releases`;

/**
 * The update manifest of the single stable channel: GitHub redirects
 * `latest/download` to the asset of the release marked latest, so the URL never changes.
 */
export const UPDATE_MANIFEST_URL = `${RELEASES_PAGE_URL}/latest/download/latest.json`;

/**
 * The public resource repository of Amber Runtime Assets. Each immutable release in it carries
 * the pinned upstream binaries together with the complete corresponding source of the GPL
 * FFmpeg build and the third-party license bundles, so the URLs written into `SOURCE.md` at
 * build time name files that already exist when the installer is signed.
 */
export const RUNTIME_ASSETS_REPOSITORY_URL = "https://github.com/lifefindsitsway/amber-runtime-assets";

/** The anonymous download URL of `file` in the Runtime Assets release tagged `tag`. */
export function runtimeAssetsDownloadUrl(tag: string, file: string): string {
  return `${RUNTIME_ASSETS_REPOSITORY_URL}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(file)}`;
}
