import { monotonicFactory } from "ulid";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/server/domain/canonical-json.ts";
import { TaskEventBus } from "../../src/server/pipeline/events.ts";
import { transact } from "../../src/server/pipeline/publish.ts";
import { createTask } from "../../src/server/pipeline/task-state.ts";
import { SSE_HEARTBEAT_MS } from "../../src/shared/defaults.ts";
import { composeServerStack, type ComposedStack } from "../fixtures/server/composed-stack.ts";

/**
 * On the whole server composition, revoking a user's sessions (suspension,
 * password reset, deletion) takes effect on the next request, and an open SSE stream is
 * closed before it would push the user's next event.
 */

const newId = monotonicFactory();
const stacks: ComposedStack[] = [];
afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.close();
});

/** A queued process_content Task on a local Content of `userId`, created without notifying anyone. */
function queuedTask(stack: ComposedStack, userId: string): string {
  const contentId = newId();
  const now = Date.now();
  return transact(stack.composition.repository, new TaskEventBus(), (scope, outbox) => {
    scope.contents.insert({ id: contentId, userId, source: { kind: "local" }, processingStatus: "queued", createdAt: now, updatedAt: now });
    return createTask(scope, outbox, {
      task: { id: newId(), userId, contentId, kind: "process_content", requestJson: canonicalJson({ requestSchemaVersion: 1, kind: "process_content" }), createdAt: now },
      sourceKind: "local",
      newId,
    }).id;
  });
}

async function readUntilClosed(body: ReadableStream<Uint8Array>, received: string[], timeoutMs: number): Promise<"closed" | "timeout"> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const deadline = setTimeout(() => void reader.cancel(), timeoutMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return "closed";
      received.push(decoder.decode(value));
    }
  } catch {
    return "timeout";
  } finally {
    clearTimeout(deadline);
  }
}

describe("session revocation on the composed server", () => {
  it("suspension rejects the old cookie and closes the user's SSE stream before its next event", async () => {
    const stack = await composeServerStack();
    stacks.push(stack);
    const bob = await stack.createUser("bob");
    const taskId = queuedTask(stack, bob.id);
    await stack.composition.app.listen({ host: "127.0.0.1", port: 0 });
    const address = stack.composition.app.server.address();
    if (address === null || typeof address === "string") throw new Error("not listening");

    const stream = await fetch(`http://127.0.0.1:${address.port}/api/tasks/events`, { headers: { cookie: bob.cookie, accept: "text/event-stream" } });
    expect(stream.status).toBe(200);
    const received: string[] = [];
    // Shorter than a heartbeat: closing must not wait for the heartbeat's database check.
    const ended = readUntilClosed(stream.body as ReadableStream<Uint8Array>, received, SSE_HEARTBEAT_MS - 5000);
    await expect.poll(() => received.join("")).toContain(": connected");

    const suspended = await stack.send({ method: "PATCH", url: `/api/admin/users/${bob.id}`, payload: { status: "suspended" } }, stack.adminCookie);
    expect(suspended.statusCode).toBe(200);
    const after = await stack.send({ method: "GET", url: "/api/auth/me" }, bob.cookie);
    expect(after.statusCode).toBe(401);

    // The scheduler now runs Bob's Task and publishes his events.
    await stack.composition.startBackground();
    expect(await ended).toBe("closed");
    expect(received.join("")).not.toContain("event:");
    const task = stack.composition.repository.withTransaction((scope) => scope.tasks.get(bob.id, taskId));
    expect(task?.statusProjection).not.toBe("queued");
  });

  it("a password reset and a deletion end every session of the user", async () => {
    const stack = await composeServerStack();
    stacks.push(stack);
    const carol = await stack.createUser("carol");
    const dave = await stack.createUser("dave");
    for (const user of [carol, dave]) {
      expect((await stack.send({ method: "GET", url: "/api/auth/me" }, user.cookie)).statusCode).toBe(200);
    }

    const reset = await stack.send({ method: "POST", url: `/api/admin/users/${carol.id}/reset-password`, payload: { newPassword: "another-placeholder-pw" } }, stack.adminCookie);
    expect(reset.statusCode).toBe(204);
    expect((await stack.send({ method: "GET", url: "/api/auth/me" }, carol.cookie)).statusCode).toBe(401);

    const deleted = await stack.send({ method: "DELETE", url: `/api/admin/users/${dave.id}` }, stack.adminCookie);
    expect(deleted.statusCode).toBe(204);
    expect((await stack.send({ method: "GET", url: "/api/auth/me" }, dave.cookie)).statusCode).toBe(401);
    expect(stack.composition.repository.withTransaction((scope) => scope.users.get(dave.id))).toBeUndefined();
  });
});
