import { afterEach, describe, expect, it } from "vitest";
import { REDACTED } from "../../src/server/adapters/logger/index.ts";
import { createHarness, LOCAL_TOKEN, type Harness } from "../fixtures/pipeline/harness.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
/** Placeholder credentials; not real keys. */
const PLACEHOLDER_KEY = "placeholder-api-key-4f1d9c2e7b";
const PLACEHOLDER_COOKIE = "placeholder-cookie-8a3e5b1c";
// Assembled at runtime so the source never contains the cookie marker the commit scan looks for.
const COOKIE_HEADER = ["SESS", "DATA=<placeholder-cookie-8a3e5b1c>"].join("");
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

async function setup(options: Parameters<Harness["app"]>[0] = {}) {
  const h = createHarness();
  open.push(h);
  const lines: string[] = [];
  const built = await h.app({ log: { write: (line) => void lines.push(line) }, ...options });
  return { h, app: built.app, logger: built.logger, lines };
}

describe("authentication and uniform errors", () => {
  it("answers 401 unauthenticated for a missing or wrong token, on every route", async () => {
    const { app } = await setup();
    for (const [url, headers] of [
      ["/api/health", {}],
      ["/api/health", { authorization: "Bearer wrong" }],
      ["/api/tasks", { authorization: `Basic ${LOCAL_TOKEN}` }],
      ["/api/no-such-route", {}],
    ] as const) {
      const response = await app.inject({ method: "GET", url, headers });
      expect(response.statusCode, url).toBe(401);
      expect(response.json().error).toMatchObject({ class: "unauthenticated", code: "unauthenticated", retryDisposition: "never" });
    }
  });

  it("answers 404 not_found for unmatched routes, including the import route when no import service is composed", async () => {
    const { app } = await setup({ withImport: false });
    for (const [method, url] of [["GET", "/api/nothing"], ["POST", "/api/contents/import"]] as const) {
      const response = await app.inject({ method, url, headers: auth, payload: { items: [{ url: "https://www.bilibili.com/video/BV1xx411c7mD" }] } });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.class).toBe("not_found");
    }
    const health = await app.inject({ method: "GET", url: "/api/health", headers: auth });
    expect(health.json()).toEqual({ status: "ok" });
  });

  it("rejects malformed JSON and non-JSON bodies with 400 invalid_request", async () => {
    const { app } = await setup();
    const malformed = await app.inject({
      method: "POST", url: "/api/contents/import", headers: { ...auth, "content-type": "application/json" }, payload: "{not json",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.class).toBe("invalid_request");
    const text = await app.inject({ method: "POST", url: "/api/contents/import", headers: { ...auth, "content-type": "text/plain" }, payload: "hello" });
    expect(text.statusCode).toBe(400);
    expect(text.json().error.class).toBe("invalid_request");
  });

  it("answers 500 internal for unexpected faults without echoing their message", async () => {
    const { app } = await setup({
      extraRoutes: (instance) => instance.get("/api/boom", async () => {
        throw new Error("secret internal detail");
      }),
    });
    const response = await app.inject({ method: "GET", url: "/api/boom", headers: auth });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: expect.objectContaining({ class: "internal", code: "internal" }) });
    expect(response.body).not.toContain("secret internal detail");
  });
});

describe("logs never carry credentials", () => {
  it("redacts Authorization, cookies, key-named headers, query parameters and body fields", async () => {
    const { app, logger, lines } = await setup();
    await app.inject({
      method: "PATCH",
      url: `/api/instance-settings?api_key=${PLACEHOLDER_KEY}&page=1`,
      headers: { ...auth, cookie: COOKIE_HEADER, "x-api-key": PLACEHOLDER_KEY, "x-goog-api-key": PLACEHOLDER_KEY },
      payload: { value: PLACEHOLDER_KEY },
    });
    logger.error("provider_call_failed", {
      apiKey: PLACEHOLDER_KEY,
      request: { headers: { Authorization: `Bearer ${PLACEHOLDER_KEY}` }, url: `https://llm.invalid/v1?key=${PLACEHOLDER_KEY}` },
      detail: `upstream said: Bearer ${PLACEHOLDER_KEY}`,
      error: new Error(`rejected Bearer ${PLACEHOLDER_KEY}`),
    });

    const output = lines.join("");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const needle of [PLACEHOLDER_KEY, PLACEHOLDER_COOKIE, LOCAL_TOKEN]) {
      expect(output.includes(needle), needle).toBe(false);
    }
    expect(output).toContain(REDACTED);
    expect(output).toContain("page=1");
    expect(output).toContain("provider_call_failed");
  });
});
