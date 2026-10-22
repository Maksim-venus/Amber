import { afterEach, describe, expect, it } from "vitest";
import { CONCURRENCY_PIPELINE_MAX } from "../../../../src/shared/defaults.ts";
import { instanceSettingsDtoSchema } from "../../../../src/shared/dto/instance-settings.ts";
import { BOB_TOKEN, createHarness, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

describe("/api/instance-settings", () => {
  it("reads and patches effective settings for an admin; environment-fixed keys stay read-only", async () => {
    const h = createHarness({ overrides: { maxDataGB: 50 } });
    open.push(h);
    const { app } = await h.app();

    const read = await app.inject({ method: "GET", url: "/api/instance-settings", headers: auth });
    expect(read.statusCode).toBe(200);
    expect(instanceSettingsDtoSchema.parse(read.json())).toMatchObject({ maxDataGB: 50, envOverridden: ["maxDataGB"] });

    const patched = await app.inject({ method: "PATCH", url: "/api/instance-settings", headers: auth, payload: { concurrencyPipeline: 3 } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().concurrencyPipeline).toBe(3);

    const fixed = await app.inject({ method: "PATCH", url: "/api/instance-settings", headers: auth, payload: { maxDataGB: 1 } });
    expect(fixed.statusCode).toBe(409);
    expect(fixed.json().error.code).toBe("conflict.setting_env_overridden");

    for (const payload of [{}, { concurrencyPipeline: 0 }, { concurrencyPipeline: CONCURRENCY_PIPELINE_MAX + 1 }, { lowWaterFreeRatio: 2 }, { maxDataGB: -1 }, { uploadRetentionDefault: "evictable" }, { updatedAt: 1 }]) {
      const invalid = await app.inject({ method: "PATCH", url: "/api/instance-settings", headers: auth, payload });
      expect(invalid.statusCode, JSON.stringify(payload)).toBe(400);
      expect(invalid.json().error.class, JSON.stringify(payload)).toBe("invalid_request");
    }
  });

  it("rejects a patch carrying a removed concurrency setting and stores nothing from it", async () => {
    const h = createHarness();
    open.push(h);
    const { app } = await h.app();
    const before = h.settings.effective();
    for (const payload of [{ concurrencyHeavy: 3 }, { concurrencyLlm: 3 }, { concurrencyPipeline: 3, concurrencyLlm: 3 }]) {
      const response = await app.inject({ method: "PATCH", url: "/api/instance-settings", headers: auth, payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json().error.class, JSON.stringify(payload)).toBe("invalid_request");
    }
    expect(h.settings.effective()).toEqual(before);
    const read = await app.inject({ method: "GET", url: "/api/instance-settings", headers: auth });
    expect(read.json()).not.toHaveProperty("concurrencyHeavy");
    expect(read.json()).not.toHaveProperty("concurrencyLlm");
  });

  it.each(["local", "server"] as const)("is forbidden to non-admin users (%s mode)", async (mode) => {
    const h = createHarness();
    open.push(h);
    const { app } = await h.app({ mode });
    const headers = { authorization: `Bearer ${BOB_TOKEN}` };
    const response = await app.inject({ method: "GET", url: "/api/instance-settings", headers });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.class).toBe("forbidden");
    const patched = await app.inject({ method: "PATCH", url: "/api/instance-settings", headers, payload: { concurrencyPipeline: 3 } });
    expect(patched.statusCode).toBe(403);
    expect(h.settings.effective().concurrencyPipeline).not.toBe(3);
  });
});
