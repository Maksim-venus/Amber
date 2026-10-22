import { afterEach, describe, expect, it } from "vitest";
import { monotonicFactory } from "ulid";
import { canonicalJson } from "../../../../src/server/domain/canonical-json.ts";
import { TaskEventBus } from "../../../../src/server/pipeline/events.ts";
import { transact } from "../../../../src/server/pipeline/publish.ts";
import { createTask } from "../../../../src/server/pipeline/task-state.ts";
import { maintenanceDtoSchema, systemActivityDtoSchema } from "../../../../src/shared/dto/backup.ts";
import { authMeDtoSchema, versionDtoSchema } from "../../../../src/shared/dto/system.ts";
import { composeLocalStack, type ComposedLocalStack } from "../../../fixtures/server/composed-local-stack.ts";
import { composeServerStack } from "../../../fixtures/server/composed-stack.ts";
import { BOB_TOKEN, createHarness, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

describe("system routes", () => {
  it("report the version with the run mode, and who the caller is", async () => {
    const h = createHarness();
    open.push(h);
    const { app } = await h.app();
    const version = await app.inject({ method: "GET", url: "/api/version", headers: { authorization: `Bearer ${LOCAL_TOKEN}` } });
    expect(versionDtoSchema.parse(version.json())).toEqual({ version: "0.0.0-test", mode: "local" });

    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${LOCAL_TOKEN}` } });
    expect(authMeDtoSchema.parse(me.json())).toEqual({ userId: "local", role: "admin", mode: "local", mustChangePassword: false });
    const bob = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${BOB_TOKEN}` } });
    expect(bob.json()).toEqual({ userId: "bob", role: "user", mode: "local", mustChangePassword: false });
    expect((await app.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
  });

  it("no longer serve the start-up self-check route", async () => {
    const h = createHarness();
    open.push(h);
    const { app } = await h.app();
    const response = await app.inject({ method: "GET", url: "/api/spike/m0", headers: { authorization: `Bearer ${LOCAL_TOKEN}` } });
    expect(response.statusCode).toBe(404);
  });
});

describe("maintenance before an update install (local composition)", () => {
  const stacks: ComposedLocalStack[] = [];
  afterEach(async () => {
    for (const stack of stacks.splice(0)) await stack.close();
  });

  async function stack(): Promise<ComposedLocalStack> {
    const created = await composeLocalStack();
    stacks.push(created);
    await created.composition.startBackground();
    return created;
  }

  function addUnfinishedTask(created: ComposedLocalStack): string {
    const repository = created.composition.repository;
    const newId = monotonicFactory();
    const contentId = newId();
    repository.withTransaction((scope) =>
      scope.contents.insert({ id: contentId, userId: "local", source: { kind: "local" }, processingStatus: "queued", createdAt: 1, updatedAt: 1 }),
    );
    return transact(repository, new TaskEventBus(), (scope, outbox) =>
      createTask(scope, outbox, {
        task: { id: newId(), userId: "local", contentId, kind: "process_content", requestJson: canonicalJson({ requestSchemaVersion: 1, kind: "process_content" }), createdAt: 1 },
        sourceKind: "local",
        newId,
      }).id,
    );
  }

  it("refuses to enter with an unfinished Task, leaving changes allowed", async () => {
    const s = await stack();
    const taskId = addUnfinishedTask(s);
    const activity = await s.send({ method: "GET", url: "/api/system/activity" });
    expect(systemActivityDtoSchema.parse(activity.json())).toEqual({ unfinishedTasks: 1, chatInflight: false, backupExport: false });
    const refused = await s.send({ method: "POST", url: "/api/system/maintenance", payload: { reason: "update_install" } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("conflict.tasks_unfinished");
    expect((await s.send({ method: "PATCH", url: "/api/settings", payload: { theme: "dark" } })).statusCode).toBe(200);
    expect((await s.send({ method: "POST", url: `/api/tasks/${taskId}/cancel` })).statusCode).toBeLessThan(300);
  });

  it("while armed refuses every change with conflict.maintenance, answers reads, and ends on DELETE", async () => {
    const s = await stack();
    const armed = await s.send({ method: "POST", url: "/api/system/maintenance", payload: { reason: "update_install" } });
    expect(armed.statusCode).toBe(200);
    expect(maintenanceDtoSchema.parse(armed.json()).until).toBeGreaterThan(Date.now());

    for (const request of [
      { method: "POST", url: "/api/contents/import", payload: { items: [{ url: "https://www.youtube.com/watch?v=placeholder0" }] } },
      { method: "POST", url: "/api/contents/local-file", payload: {} },
      { method: "POST", url: "/api/tasks/01TASK/retry-stage", payload: { stage: "asr" } },
      { method: "POST", url: "/api/contents/01CONTENT/chat/messages", payload: { text: "hi" } },
      { method: "POST", url: "/api/backup/exports", payload: {} },
      { method: "PATCH", url: "/api/settings", payload: { theme: "dark" } },
      { method: "POST", url: "/api/system/maintenance", payload: { reason: "update_install" } },
    ] as const) {
      const response = await s.send(request);
      expect(response.statusCode, request.url).toBe(409);
      expect(response.json().error.code, request.url).toBe("conflict.maintenance");
    }
    expect((await s.send({ method: "GET", url: "/api/settings" })).statusCode).toBe(200);
    expect((await s.send({ method: "GET", url: "/api/contents" })).statusCode).toBe(200);
    expect((await s.send({ method: "GET", url: "/api/system/activity" })).statusCode).toBe(200);

    expect((await s.send({ method: "DELETE", url: "/api/system/maintenance" })).statusCode).toBe(204);
    expect((await s.send({ method: "PATCH", url: "/api/settings", payload: { theme: "dark" } })).statusCode).toBe(200);
  });

  it("rejects a body without the update-install reason", async () => {
    const s = await stack();
    const response = await s.send({ method: "POST", url: "/api/system/maintenance", payload: { reason: "other" } });
    expect(response.statusCode).toBe(400);
    expect((await s.send({ method: "PATCH", url: "/api/settings", payload: { theme: "dark" } })).statusCode).toBe(200);
  });

  it("does not exist in server mode", async () => {
    const created = await composeServerStack();
    try {
      for (const request of [
        { method: "GET", url: "/api/system/activity" },
        { method: "POST", url: "/api/system/maintenance", payload: { reason: "update_install" } },
        { method: "DELETE", url: "/api/system/maintenance" },
      ] as const) {
        expect((await created.send(request, created.adminCookie)).statusCode, request.url).toBe(404);
      }
    } finally {
      await created.close();
    }
  });
});
