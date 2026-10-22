import { join, sep } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SERVER_CSP } from "../../shared/security/csp.ts";

/** Vite emits content-hashed bundles here; their URLs change whenever their bytes do. */
const HASHED_ASSETS_DIR = "assets";
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";

/**
 * Security headers on every server-mode response, set before routing so
 * rejections, static files and SSE streams (which copy the reply headers before they
 * hijack) all carry them.
 */
export function installSecurityHeaders(app: FastifyInstance): void {
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("content-security-policy", SERVER_CSP);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
  });
}

/**
 * Serves the built SPA in server mode: `/api/**` stays the API, hashed bundles
 * are cached forever, everything else revalidates, and a GET outside `/api` that matches
 * no file is answered with `index.html` so deep links survive a reload. Local mode does
 * not use this; the desktop shell loads the SPA itself.
 */
export async function registerWebHosting(app: FastifyInstance, options: { root: string }): Promise<void> {
  const hashed = join(options.root, HASHED_ASSETS_DIR) + sep;
  await app.register(fastifyStatic, {
    root: options.root,
    prefix: "/",
    wildcard: true,
    index: ["index.html"],
    cacheControl: false,
    // `/api` never maps onto the file tree, even if a file of that name were built.
    allowedPath: (pathName) => !isApiPath(pathName),
    setHeaders: (reply, path) => {
      reply.header("cache-control", path.startsWith(hashed) ? IMMUTABLE : REVALIDATE);
    },
  });
}

/** The SPA fallback for the not-found handler: GET / HEAD outside `/api` get `index.html`. */
export function spaFallback(request: FastifyRequest, reply: FastifyReply): FastifyReply | undefined {
  if ((request.method !== "GET" && request.method !== "HEAD") || isApiPath(request.url)) {
    return undefined;
  }
  reply.header("cache-control", REVALIDATE);
  return reply.code(200).sendFile("index.html");
}

export function isApiPath(url: string): boolean {
  return url === "/api" || url.startsWith("/api/") || url.startsWith("/api?");
}
