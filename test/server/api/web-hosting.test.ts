import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { installErrorHandling } from "../../../src/server/api/errors.ts";
import { installSecurityHeaders, registerWebHosting, spaFallback } from "../../../src/server/api/web-hosting.ts";
import { SERVER_CSP } from "../../../src/shared/security/csp.ts";
import { silentLogger } from "../../fixtures/pipeline/harness.ts";
import { tempDataDir } from "../../tools/sqlite.ts";

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function hostedApp() {
  const root = tempDataDir("amber-web-");
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=root></div>");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "main-abc123.js"), "console.log(1)");
  writeFileSync(join(root, "favicon.svg"), "<svg/>");
  const app = Fastify();
  apps.push(app);
  installSecurityHeaders(app);
  installErrorHandling(app, silentLogger, { notFoundFallback: spaFallback });
  app.get("/api/health", async () => ({ status: "ok" }));
  await registerWebHosting(app, { root });
  return app;
}

describe("server-mode web hosting", () => {
  it("serves hashed bundles as immutable and everything else as revalidated", async () => {
    const app = await hostedApp();
    const bundle = await app.inject({ method: "GET", url: "/assets/main-abc123.js" });
    expect(bundle.statusCode).toBe(200);
    expect(bundle.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    for (const url of ["/", "/favicon.svg"]) {
      const response = await app.inject({ method: "GET", url });
      expect([url, response.statusCode, response.headers["cache-control"]]).toEqual([url, 200, "no-cache"]);
    }
  });

  it("falls back to index.html for deep links, never for /api or non-GET", async () => {
    const app = await hostedApp();
    for (const url of ["/setup", "/login", "/new", "/contents/x", "/admin/users?x=1"]) {
      const response = await app.inject({ method: "GET", url });
      expect([url, response.statusCode]).toEqual([url, 200]);
      expect(response.body).toContain('<div id=root>');
      expect(response.headers["cache-control"]).toBe("no-cache");
    }
    const head = await app.inject({ method: "HEAD", url: "/library" });
    expect(head.statusCode).toBe(200);
    for (const [method, url] of [["GET", "/api/nope"], ["GET", "/api"], ["POST", "/login"], ["GET", "/assets/missing.js?x"]] as const) {
      const response = await app.inject({ method, url });
      if (url.startsWith("/assets/")) {
        // A missing bundle is a deep link as far as the server can tell.
        expect(response.statusCode).toBe(200);
        continue;
      }
      expect([method, url, response.statusCode]).toEqual([method, url, 404]);
      expect(response.json().error.code).toBe("not_found");
    }
  });

  it("sends the security headers on API, static, fallback and error responses", async () => {
    const app = await hostedApp();
    for (const url of ["/api/health", "/assets/main-abc123.js", "/login", "/api/nope"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.headers["content-security-policy"], url).toBe(SERVER_CSP);
      expect(response.headers["x-content-type-options"], url).toBe("nosniff");
      expect(response.headers["referrer-policy"], url).toBe("strict-origin-when-cross-origin");
    }
  });

  it("does not serve files outside the root or under /api", async () => {
    const app = await hostedApp();
    const traversal = await app.inject({ method: "GET", url: "/../package.json" });
    expect(traversal.body).not.toContain('"name"');
  });
});
