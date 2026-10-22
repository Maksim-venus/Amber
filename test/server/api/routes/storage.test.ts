import { afterEach, describe, expect, it } from "vitest";
import { LocalFileStore } from "../../../../src/server/adapters/file-store/local-file-store.ts";
import { registerStorageRoutes } from "../../../../src/server/api/routes/storage.ts";
import { StorageQuota } from "../../../../src/server/application/storage-quota.ts";
import { BOB, BOB_TOKEN, createHarness, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

describe("GET /api/storage", () => {
  it("answers each user with their own bytes and limit only", async () => {
    const h = createHarness();
    open.push(h);
    const files = new LocalFileStore(h.dir);
    await files.writeAtomic(`assets/${BOB.userId}/c1/a1`, new Uint8Array(1500));
    h.db.prepare("UPDATE user SET storage_limit_gb = ? WHERE id = ?").run(0.2, BOB.userId);
    const quota = new StorageQuota({ repository: h.repository, files });
    const { app } = await h.app({ extraRoutes: (instance) => registerStorageRoutes(instance, { quota }) });

    const bob = await app.inject({ method: "GET", url: "/api/storage", headers: { authorization: `Bearer ${BOB_TOKEN}` } });
    expect(bob.statusCode).toBe(200);
    expect(bob.json()).toEqual({ usedBytes: 1500, storageLimitGB: 0.2 });
    const local = await app.inject({ method: "GET", url: "/api/storage", headers: { authorization: `Bearer ${LOCAL_TOKEN}` } });
    expect(local.json()).toEqual({ usedBytes: 0 });
    expect((await app.inject({ method: "GET", url: "/api/storage" })).statusCode).toBe(401);
  });
});
