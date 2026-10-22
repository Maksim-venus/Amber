import { afterEach, describe, expect, it } from "vitest";
import { registerOtherModelRoutes } from "../../../../src/server/api/routes/other-models.ts";
import { OtherModelService } from "../../../../src/server/application/other-models.ts";
import { BOB_TOKEN, createHarness, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";
import { countRows } from "../../../tools/sqlite.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

async function setup() {
  const h = createHarness();
  open.push(h);
  const otherModels = new OtherModelService({ repository: h.repository, newId: h.newId });
  const { app } = await h.app({ extraRoutes: (instance) => registerOtherModelRoutes(instance, { otherModels }) });
  return { h, app };
}

const PER_IMAGE = { currency: "USD", items: [{ unit: "per_image", amount: "0.04" }] };

describe("/api/other-models", () => {
  it("creates, lists, edits, prices, orders and deletes register entries", async () => {
    const { h, app } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/other-models", headers: auth })).json()).toEqual({ items: [] });
    const created = await app.inject({
      method: "POST",
      url: "/api/other-models",
      headers: auth,
      payload: { name: "图片", note: "只登记", models: [{ modelId: "vendor/image-1", kind: "image_generation" }] },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };
    expect(created.json()).toMatchObject({ name: "图片", note: "只登记", models: [{ modelId: "vendor/image-1", kind: "image_generation" }] });

    const priced = await app.inject({ method: "PUT", url: `/api/other-models/${id}/model-pricing`, headers: auth, payload: { modelId: "vendor/image-1", pricing: PER_IMAGE } });
    expect(priced.statusCode).toBe(200);
    expect(priced.json().models[0].pricing).toEqual(PER_IMAGE);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/other-models/${id}`,
      headers: auth,
      payload: { name: "生成", note: null, models: [{ modelId: "vendor/image-1", kind: "other" }, { modelId: "tts-1", kind: "tts" }] },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toEqual({
      id,
      name: "生成",
      models: [
        { modelId: "vendor/image-1", kind: "other", pricing: PER_IMAGE },
        { modelId: "tts-1", kind: "tts" },
      ],
      createdAt: created.json().createdAt,
    });

    const second = (await app.inject({ method: "POST", url: "/api/other-models", headers: auth, payload: { name: "视频", models: [] } })).json() as { id: string };
    const ordered = await app.inject({ method: "PUT", url: "/api/other-models/order", headers: auth, payload: { profileIds: [second.id, id] } });
    expect(ordered.statusCode).toBe(200);
    expect((ordered.json() as { items: Array<{ id: string }> }).items.map((item) => item.id)).toEqual([second.id, id]);
    expect((await app.inject({ method: "PUT", url: "/api/other-models/order", headers: auth, payload: { profileIds: [id] } })).statusCode).toBe(400);

    expect((await app.inject({ method: "DELETE", url: `/api/other-models/${second.id}`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/other-models/${second.id}`, headers: auth })).statusCode).toBe(404);
    expect(countRows(h.db, "other_model_profile")).toBe(1);
  });

  it("validates bodies: kinds, repeated ids, note length, price bounds and unknown fields", async () => {
    const { app } = await setup();
    const post = (payload: object) => app.inject({ method: "POST", url: "/api/other-models", headers: auth, payload });
    for (const payload of [
      { name: "x", models: [{ modelId: "a", kind: "llm" }] },
      { name: "x", models: [{ modelId: "a", kind: "tts" }, { modelId: "a", kind: "tts" }] },
      { name: "x", note: "n".repeat(501), models: [] },
      { name: "", models: [] },
      { name: "x", models: [], value: "secret" },
      { name: "x" },
    ]) {
      expect((await post(payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    const { id } = (await post({ name: "x", note: "n".repeat(500), models: [{ modelId: "a", kind: "tts" }] })).json() as { id: string };
    const price = (pricing: unknown) => app.inject({ method: "PUT", url: `/api/other-models/${id}/model-pricing`, headers: auth, payload: { modelId: "a", pricing } });
    // Every unit is offered here, audio and characters alike.
    expect((await price({ currency: "CNY", items: [{ unit: "characters_per_ten_thousand", amount: "2" }, { unit: "audio_per_minute", amount: "0.5" }] })).statusCode).toBe(200);
    expect((await price({ currency: "CNY", items: [{ unit: "per_image", amount: "1,5" }] })).statusCode).toBe(400);
    expect((await price({ currency: "CNY", items: [{ unit: "per_token", amount: "1" }] })).statusCode).toBe(400);
  });

  it("keeps another user away from the register", async () => {
    const { app } = await setup();
    const { id } = (await app.inject({ method: "POST", url: "/api/other-models", headers: auth, payload: { name: "mine", models: [{ modelId: "a", kind: "tts" }] } })).json() as { id: string };
    expect((await app.inject({ method: "GET", url: "/api/other-models", headers: bob })).json()).toEqual({ items: [] });
    expect((await app.inject({ method: "PATCH", url: `/api/other-models/${id}`, headers: bob, payload: { name: "taken" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: `/api/other-models/${id}/model-pricing`, headers: bob, payload: { modelId: "a", pricing: PER_IMAGE } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/other-models/${id}`, headers: bob })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: "/api/other-models/order", headers: bob, payload: { profileIds: [id] } })).statusCode).toBe(400);
    expect(((await app.inject({ method: "GET", url: "/api/other-models", headers: auth })).json() as { items: Array<{ name: string }> }).items.map((item) => item.name)).toEqual(["mine"]);
  });
});
