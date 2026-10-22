import { afterEach, describe, expect, it } from "vitest";
import { registerAdminRoutes } from "../../../../src/server/api/routes/admin.ts";
import {
  adminStorageDtoSchema,
  adminUserDtoSchema,
  adminUserListDtoSchema,
  credentialsResetDtoSchema,
  networkAllowlistDtoSchema,
} from "../../../../src/shared/dto/admin.ts";
import { PASSWORD_MIN_LEN } from "../../../../src/shared/defaults.ts";
import { createAdmin, insertSession } from "../../../fixtures/pipeline/admin.ts";
import { BOB, BOB_TOKEN, createHarness, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";

const admin = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const PASSWORD = "p".repeat(PASSWORD_MIN_LEN);
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

async function setup(mode: "local" | "server" = "server") {
  const h = createHarness();
  open.push(h);
  const stack = createAdmin(h);
  const { app } = await h.app({ mode, extraRoutes: (instance) => registerAdminRoutes(instance, { admin: stack.admin, mode }) });
  return { h, app, ...stack };
}

describe("/api/admin/* [server]", () => {
  it("creates, lists, patches, resets and deletes users", async () => {
    const { app, h } = await setup();
    const created = await app.inject({ method: "POST", url: "/api/admin/users", headers: admin, payload: { username: "Carol", password: PASSWORD, role: "user" } });
    expect(created.statusCode).toBe(201);
    const carol = adminUserDtoSchema.parse(created.json());
    expect(carol).toMatchObject({ username: "carol", mustChangePassword: true });
    expect(JSON.stringify(created.json())).not.toContain(PASSWORD);

    const listed = await app.inject({ method: "GET", url: "/api/admin/users", headers: admin });
    expect(adminUserListDtoSchema.parse(listed.json()).users.map((user) => user.id)).toContain(carol.id);

    const duplicate = await app.inject({ method: "POST", url: "/api/admin/users", headers: admin, payload: { username: "CAROL", password: PASSWORD, role: "user" } });
    expect([duplicate.statusCode, duplicate.json().error.code]).toEqual([409, "conflict.username_taken"]);

    const patched = await app.inject({ method: "PATCH", url: `/api/admin/users/${carol.id}`, headers: admin, payload: { status: "suspended", storageLimitGB: 5 } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ status: "suspended", storageLimitGB: 5 });

    const reset = await app.inject({ method: "POST", url: `/api/admin/users/${carol.id}/reset-password`, headers: admin, payload: { newPassword: PASSWORD } });
    expect(reset.statusCode).toBe(204);

    const deleted = await app.inject({ method: "DELETE", url: `/api/admin/users/${carol.id}`, headers: admin });
    expect(deleted.statusCode).toBe(204);
    expect(h.repository.withTransaction((scope) => scope.users.get(carol.id))).toBeUndefined();
    const again = await app.inject({ method: "DELETE", url: `/api/admin/users/${carol.id}`, headers: admin });
    expect(again.statusCode).toBe(404);
  });

  it("validates bodies strictly and protects the last administrator", async () => {
    const { app } = await setup();
    for (const payload of [{}, { username: "dave", password: PASSWORD }, { username: "dave", password: PASSWORD, role: "root" }, { username: "dave", password: PASSWORD, role: "user", extra: 1 }]) {
      const response = await app.inject({ method: "POST", url: "/api/admin/users", headers: admin, payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const short = await app.inject({ method: "POST", url: "/api/admin/users", headers: admin, payload: { username: "dave", password: "short", role: "user" } });
    expect(short.statusCode).toBe(400);
    for (const payload of [{}, { status: "gone" }, { storageLimitGB: 0 }, { mustChangePassword: false }]) {
      const response = await app.inject({ method: "PATCH", url: `/api/admin/users/${BOB.userId}`, headers: admin, payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const last = await app.inject({ method: "PATCH", url: "/api/admin/users/local", headers: admin, payload: { role: "user" } });
    expect([last.statusCode, last.json().error.code]).toEqual([409, "conflict.last_admin"]);
    const self = await app.inject({ method: "DELETE", url: "/api/admin/users/local", headers: admin });
    expect(self.statusCode).toBe(409);
  });

  it("reports storage and replaces the network allowlist", async () => {
    const { app } = await setup();
    const storage = await app.inject({ method: "GET", url: "/api/admin/storage", headers: admin });
    expect(storage.statusCode).toBe(200);
    expect(adminStorageDtoSchema.parse(storage.json()).users.map((user) => user.userId)).toEqual(expect.arrayContaining(["local", BOB.userId]));

    const put = await app.inject({ method: "PUT", url: "/api/admin/network-allowlist", headers: admin, payload: { origins: ["HTTPS://Relay.Example:8443"] } });
    expect(networkAllowlistDtoSchema.parse(put.json())).toEqual({ origins: ["https://relay.example:8443"] });
    for (const origins of [["https://*.example"], ["10.0.0.0/8"]]) {
      const rejected = await app.inject({ method: "PUT", url: "/api/admin/network-allowlist", headers: admin, payload: { origins } });
      expect([rejected.statusCode, rejected.json().error.code]).toEqual([400, "invalid_request.allowlist_entry"]);
    }
    const read = await app.inject({ method: "GET", url: "/api/admin/network-allowlist", headers: admin });
    expect(read.json()).toEqual({ origins: ["https://relay.example:8443"] });
  });

  it("answers 403 to a non-admin on every admin endpoint, before validating the body", async () => {
    const { app, h } = await setup();
    insertSession(h, BOB.userId, "bob-1");
    const calls = [
      { method: "GET", url: "/api/admin/users" },
      { method: "POST", url: "/api/admin/users", payload: { nonsense: true } },
      { method: "PATCH", url: "/api/admin/users/local", payload: { status: "suspended" } },
      { method: "POST", url: "/api/admin/users/local/reset-password", payload: {} },
      { method: "DELETE", url: "/api/admin/users/local" },
      { method: "GET", url: "/api/admin/storage" },
      { method: "GET", url: "/api/admin/network-allowlist" },
      { method: "PUT", url: "/api/admin/network-allowlist", payload: { origins: "x" } },
      { method: "POST", url: "/api/admin/credentials/reset" },
    ] as const;
    for (const call of calls) {
      const response = await app.inject({ ...call, headers: bob });
      expect([response.statusCode, response.json().error.class], `${call.method} ${call.url}`).toEqual([403, "forbidden"]);
    }
    expect(h.repository.withTransaction((scope) => scope.users.get("local"))?.status).toBe("active");
  });
});

describe("POST /api/admin/credentials/reset", () => {
  it("exists in both modes; the user routes only in server mode", async () => {
    for (const mode of ["local", "server"] as const) {
      const { app } = await setup(mode);
      const reset = await app.inject({ method: "POST", url: "/api/admin/credentials/reset", headers: admin });
      expect(reset.statusCode, mode).toBe(200);
      expect(credentialsResetDtoSchema.parse(reset.json()).credentialsResetAt).toBeGreaterThan(0);
      const users = await app.inject({ method: "GET", url: "/api/admin/users", headers: admin });
      expect(users.statusCode, mode).toBe(mode === "server" ? 200 : 404);
    }
  });
});
