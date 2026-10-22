import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { amberError } from "../../domain/errors.ts";
import { principalOf } from "../auth.ts";

/** File name of the bundled subtitle font in the fonts directory beside `AMBER_BIN_DIR`; the fixed ASS styles name this font. */
export const SUBTITLE_FONT_FILE = "NotoSansSC-Regular.otf";

/**
 * The bundled subtitle font file. Its SHA-256 is computed once per file version (size and
 * modification time) and reused: it is the route's ETag and part of a styled export's
 * input digest, and the file only changes when the runtime assets are replaced.
 */
export class BundledSubtitleFont {
  readonly path: string;
  private cached: { key: string; sha256: Promise<string> } | undefined;

  constructor(path: string) {
    this.path = path;
  }

  /** Size and hex SHA-256 of the font; `not_found` when the file is missing. */
  async describe(): Promise<{ sizeBytes: number; sha256: string }> {
    const info = await stat(this.path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        throw amberError("not_found", "the bundled subtitle font is missing");
      }
      throw error;
    });
    const key = `${info.size}:${info.mtimeMs}`;
    if (this.cached?.key !== key) {
      const sha256 = hashFile(this.path);
      const entry = { key, sha256 };
      this.cached = entry;
      sha256.catch(() => {
        if (this.cached === entry) {
          this.cached = undefined;
        }
      });
    }
    return { sizeBytes: info.size, sha256: await this.cached.sha256 };
  }

  /** `sha256:<hex>`, the digest format of every other file Amber records. */
  async digest(): Promise<string> {
    return `sha256:${(await this.describe()).sha256}`;
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/** Whether an `If-None-Match` header names `etag` (or is `*`); weak and strong forms compare alike. */
function matches(header: string | undefined, etag: string): boolean {
  if (header === undefined) {
    return false;
  }
  return header.split(",").some((candidate) => {
    const tag = candidate.trim();
    return tag === "*" || tag.replace(/^W\//u, "") === etag;
  });
}

/**
 * `GET /api/fonts/subtitle` (both modes): the bundled subtitle
 * font, so the player overlay draws with the font the export uses. `no-cache` with the
 * digest as ETag lets the WebView keep it and revalidate cheaply after an update.
 */
export function registerFontRoutes(app: FastifyInstance, deps: { font: BundledSubtitleFont }): void {
  app.get("/api/fonts/subtitle", async (request, reply) => {
    principalOf(request);
    const { sizeBytes, sha256 } = await deps.font.describe();
    const etag = `"${sha256}"`;
    reply.header("etag", etag).header("cache-control", "private, no-cache");
    if (matches(request.headers["if-none-match"], etag)) {
      return reply.code(304).send();
    }
    return reply.code(200).header("content-type", "font/otf").header("content-length", String(sizeBytes)).send(createReadStream(deps.font.path));
  });
}
