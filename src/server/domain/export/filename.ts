/** Longest exported file name stem, in code points. */
const FILENAME_STEM_MAX_CHARS = 100;

// Path separators, characters Windows refuses in names, and C0 controls.
const UNSAFE = /[/\\:*?"<>|\u0000-\u001f\u007f]/gu;

/**
 * The download name of an export: the title without path or control
 * characters, trimmed and cut to `FILENAME_STEM_MAX_CHARS` code points, or `fallback`
 * when nothing is left; then the extension.
 */
export function exportFilename(title: string | undefined, fallback: string, extension: string): string {
  const cleaned = [...(title ?? "").replace(UNSAFE, "").trim()].slice(0, FILENAME_STEM_MAX_CHARS).join("").trim();
  return `${cleaned === "" ? fallback : cleaned}.${extension}`;
}

/** `Content-Disposition` for an export: RFC 6266 `attachment` with the RFC 5987 `filename*` form. */
export function contentDisposition(filename: string): string {
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename*=UTF-8''${encoded}`;
}
