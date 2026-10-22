import { afterEach, describe, expect, it } from "vitest";
import { registerTerminologyRoutes } from "../../../../src/server/api/routes/terminology.ts";
import { TerminologyService } from "../../../../src/server/application/terminology.ts";
import { TERMINOLOGY_TERM_MAX_CHARS } from "../../../../src/shared/defaults.ts";
import { BOB_TOKEN, createHarness, createLocalContent, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

async function setup() {
  const h = createHarness();
  open.push(h);
  const terminology = new TerminologyService({ repository: h.repository, newId: h.newId });
  const { app } = await h.app({ extraRoutes: (instance) => registerTerminologyRoutes(instance, { terminology }) });
  return { h, app };
}

describe("/api/terminology", () => {
  it("reads and replaces a scope's set", async () => {
    const { h, app } = await setup();
    const contentId = createLocalContent(h);
    const url = `/api/terminology?scope=content:${contentId}`;
    expect((await app.inject({ method: "GET", url, headers: auth })).json()).toEqual({ scope: `content:${contentId}`, entries: [] });
    const put = await app.inject({ method: "PUT", url, headers: auth, payload: { entries: [{ term: "RAG", translation: "检索增强生成" }, { term: "Prompt", rule: "keep_original" }] } });
    expect(put.statusCode).toBe(200);
    expect(put.json().entries).toMatchObject([
      { ordinal: 0, term: "RAG", normalizedKey: "rag", translation: "检索增强生成" },
      { ordinal: 1, term: "Prompt", normalizedKey: "prompt", rule: "keep_original" },
    ]);
    expect((await app.inject({ method: "GET", url, headers: auth })).json()).toEqual(put.json());
    expect((await app.inject({ method: "GET", url, headers: bob })).statusCode).toBe(404);
  });

  it("answers 400 for bad scopes, over-long terms, duplicates and unknown fields", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/terminology", headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/terminology?scope=all", headers: auth })).statusCode).toBe(400);
    const put = (payload: unknown) => app.inject({ method: "PUT", url: "/api/terminology?scope=global", headers: auth, payload: payload as object });
    expect((await put({ entries: [{ term: "x".repeat(TERMINOLOGY_TERM_MAX_CHARS + 1) }] })).statusCode).toBe(400);
    expect((await put({ entries: [{ term: "RAG" }, { term: "rag" }] })).json().error.code).toBe("invalid_request");
    expect((await put({ entries: [{ term: "RAG", normalizedKey: "x" }] })).statusCode).toBe(400);
    expect((await put({ entries: [{ term: "RAG", rule: "translate" }] })).statusCode).toBe(400);
  });
});
