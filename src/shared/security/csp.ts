/**
 * Content-Security-Policy of the SPA: one base shared by both run modes,
 * plus the sources only the desktop WebView needs (Tauri IPC, the sidecar on loopback, the
 * asset protocol for local media) or only the server needs (same-origin media and blobs).
 * `tauri.conf.json` must state exactly `base + localExtra`; the server sends
 * `base + serverExtra` on every response.
 */

export type CspDirectives = Readonly<Record<string, readonly string[]>>;

export const CSP_BASE: CspDirectives = {
  "default-src": ["'self'"],
  // The YouTube IFrame Player API is loaded from its own origin.
  "script-src": ["'self'", "https://www.youtube.com"],
  "frame-src": ["https://www.youtube.com", "https://player.bilibili.com"],
  "connect-src": ["'self'"],
  "img-src": ["'self'", "data:", "https:"],
  "style-src": ["'self'", "'unsafe-inline'"],
};

export const CSP_LOCAL_EXTRA: CspDirectives = {
  "connect-src": ["ipc:", "http://ipc.localhost", "http://127.0.0.1:*"],
  "media-src": ["asset:", "http://asset.localhost"],
};

export const CSP_SERVER_EXTRA: CspDirectives = {
  "media-src": ["'self'", "blob:"],
};

/** Union per directive, sources in order of first appearance. */
export function mergeCsp(...parts: readonly CspDirectives[]): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const part of parts) {
    for (const [directive, sources] of Object.entries(part)) {
      const list = (merged[directive] ??= []);
      for (const source of sources) {
        if (!list.includes(source)) {
          list.push(source);
        }
      }
    }
  }
  return merged;
}

/** The header form: `directive source source; directive ...`. */
export function serializeCsp(directives: Readonly<Record<string, readonly string[]>>): string {
  return Object.entries(directives)
    .map(([directive, sources]) => [directive, ...sources].join(" "))
    .join("; ");
}

export const LOCAL_CSP = mergeCsp(CSP_BASE, CSP_LOCAL_EXTRA);
export const SERVER_CSP = serializeCsp(mergeCsp(CSP_BASE, CSP_SERVER_EXTRA));
