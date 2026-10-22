import { useEffect, useState } from "react";
import { SUBTITLE_FONT_MAX_BYTES } from "../../shared/defaults.ts";
import type { ApiClient } from "../api/client.ts";
import { useApi } from "../api/context.tsx";

/** The family the bundled font registers as; exports render with the same font. */
export const SUBTITLE_FONT_FAMILY = "Noto Sans SC";
/** The overlay's font stack: the bundled font, then whatever the system offers. */
export const SUBTITLE_FONT_STACK = `"${SUBTITLE_FONT_FAMILY}", sans-serif`;

const FONT_PATH = "/api/fonts/subtitle";
const FONT_MIME = "font/otf";

let loading: Promise<boolean> | undefined;

/**
 * Fetches the bundled subtitle font and registers it with the document, once per page
 * Resolves false when the font cannot be had — no FontFace API, a failed or
 * refused download — and forgets that failure, so the next attempt tries again.
 */
export function loadSubtitleFont(client: ApiClient): Promise<boolean> {
  if (loading !== undefined) return loading;
  const attempt = (async () => {
    const FontFaceClass = globalThis.FontFace as typeof FontFace | undefined;
    const fonts = typeof document === "undefined" ? undefined : (document.fonts as FontFaceSet | undefined);
    if (FontFaceClass === undefined || fonts === undefined) return false;
    const buffer = await client.bytes(FONT_PATH, { accept: FONT_MIME, maxBytes: SUBTITLE_FONT_MAX_BYTES });
    const face = new FontFaceClass(SUBTITLE_FONT_FAMILY, buffer);
    await face.load();
    fonts.add(face);
    return true;
  })().catch(() => false);
  loading = attempt.then((ok) => {
    if (!ok) loading = undefined;
    return ok;
  });
  return loading;
}

/** Forgets the loaded font; tests use it between cases. */
export function resetSubtitleFont(): void {
  loading = undefined;
}

/**
 * Whether the overlay previews with a fallback font: false until `enabled` first turns true
 * (the font is only fetched once subtitles are switched on), then true if loading failed.
 */
export function useSubtitleFontFallback(enabled: boolean): boolean {
  const client = useApi();
  const [fallback, setFallback] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    void loadSubtitleFont(client).then((ok) => {
      if (live) setFallback(!ok);
    });
    return () => {
      live = false;
    };
  }, [enabled, client]);
  return fallback;
}
