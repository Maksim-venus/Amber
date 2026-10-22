import { afterEach, describe, expect, it } from "vitest";
import { BOB_TOKEN, createHarness, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function setup() {
  const h = createHarness();
  open.push(h);
  const { app } = await h.app();
  return { h, app };
}

describe("/api/summary-templates", () => {
  it("lists builtin templates, creates a custom one, versions it on prompt change and soft-deletes it", async () => {
    const { app } = await setup();
    const listed = await app.inject({ method: "GET", url: "/api/summary-templates", headers: auth });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items.map((item: { id: string }) => item.id)).toEqual(["summary.core", "summary.detailed", "summary.terms"]);

    const created = await app.inject({ method: "POST", url: "/api/summary-templates", headers: auth, payload: { name: "Mine", prompt: "v1" } });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();
    expect(created.json()).toMatchObject({ builtin: false, currentVersion: 1, deleted: false });

    const renamed = await app.inject({ method: "PATCH", url: `/api/summary-templates/${id}`, headers: auth, payload: { name: "Renamed" } });
    expect(renamed.json()).toMatchObject({ name: "Renamed", currentVersion: 1 });
    const edited = await app.inject({ method: "PATCH", url: `/api/summary-templates/${id}`, headers: auth, payload: { prompt: "v2" } });
    expect(edited.json()).toMatchObject({ currentVersion: 2 });
    const versions = await app.inject({ method: "GET", url: `/api/summary-templates/${id}/versions`, headers: auth });
    expect(versions.json().items.map((item: { version: number; prompt: string }) => [item.version, item.prompt])).toEqual([
      [1, "v1"],
      [2, "v2"],
    ]);

    expect((await app.inject({ method: "DELETE", url: `/api/summary-templates/${id}`, headers: bob })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/summary-templates/${id}`, headers: auth })).statusCode).toBe(204);
    const after = await app.inject({ method: "GET", url: "/api/summary-templates", headers: auth });
    expect(after.json().items.map((item: { id: string }) => item.id)).not.toContain(id);
  });

  it("answers 403 for builtin templates and 400 for invalid bodies", async () => {
    const { app } = await setup();
    const patch = await app.inject({ method: "PATCH", url: "/api/summary-templates/summary.core", headers: auth, payload: { prompt: "x" } });
    expect(patch.statusCode).toBe(403);
    expect(patch.json().error.class).toBe("forbidden");
    expect((await app.inject({ method: "DELETE", url: "/api/summary-templates/summary.core", headers: auth })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/summary-templates", headers: auth, payload: { name: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/summary-templates", headers: auth, payload: { name: "x", prompt: "y".repeat(8001) } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/api/summary-templates/summary.core", headers: auth, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/summary-templates" })).statusCode).toBe(401);
  });
});
