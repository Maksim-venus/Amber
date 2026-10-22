import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BundledSubtitleFont, registerFontRoutes } from "../../../../src/server/api/routes/fonts.ts";
import { createHarness, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";
import { tempDataDir } from "../../../tools/sqlite.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

async function setup(path: string) {
  const h = createHarness();
  open.push(h);
  const font = new BundledSubtitleFont(path);
  const { app } = await h.app({ extraRoutes: (instance) => registerFontRoutes(instance, { font }) });
  const get = (headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url: "/api/fonts/subtitle", headers: { authorization: `Bearer ${LOCAL_TOKEN}`, ...headers } });
  return { h, font, app, get };
}

describe("GET /api/fonts/subtitle", () => {
  it("streams the font with its digest as ETag, revalidated each time, and answers a matching If-None-Match with 304", async () => {
    const path = join(tempDataDir("amber-font-"), "NotoSansSC-Regular.otf");
    writeFileSync(path, "OTTO font bytes");
    const { font, app, get } = await setup(path);
    const sha = createHash("sha256").update(readFileSync(path)).digest("hex");

    const first = await get();
    expect(first.statusCode).toBe(200);
    expect(first.headers).toMatchObject({ "content-type": "font/otf", etag: `"${sha}"`, "cache-control": "private, no-cache", "content-length": "15" });
    expect(first.body).toBe("OTTO font bytes");
    expect(await font.digest()).toBe(`sha256:${sha}`);

    const cached = await get({ "if-none-match": `W/"other", "${sha}"` });
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toBe("");
    expect(cached.headers["etag"]).toBe(`"${sha}"`);
    expect((await get({ "if-none-match": `"other"` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/fonts/subtitle" })).statusCode).toBe(401);
  });

  it("is not_found when the bundled font is missing", async () => {
    const { get } = await setup(join(tempDataDir("amber-font-"), "missing.otf"));
    const response = await get();
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { class: "not_found" } });
  });
});
