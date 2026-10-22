import { request as httpRequest, type IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SSE_HEARTBEAT_MS } from "../../../src/shared/defaults.ts";
import type { TaskEvent } from "../../../src/shared/sse/events.ts";
import { createServerApp, type ServerApp } from "../../fixtures/server/server-app.ts";

const open: ServerApp[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const created of open.splice(0)) await created.close();
});

interface OpenStream {
  response: IncomingMessage;
  text: () => string;
  ended: Promise<void>;
}

async function openStream(s: ServerApp, cookie: string): Promise<OpenStream> {
  const address = await s.app.listen({ host: "127.0.0.1", port: 0 });
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(`${address}/api/tasks/events`, { headers: { cookie, accept: "text/event-stream" } }, (response) => {
      let received = "";
      const ended = new Promise<void>((done) => response.once("end", () => done()));
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        received += chunk;
      });
      // Resolve once the connection comment arrived.
      response.once("data", () => resolve({ response, text: () => received, ended }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

function event(taskId: string): TaskEvent {
  return { type: "task.updated", task: { id: taskId } } as unknown as TaskEvent;
}

describe("task event stream and session revocation", () => {
  it("delivers the user's events while the session lives and closes before the push after revocation", async () => {
    const s = await createServerApp();
    open.push(s);
    const id = await s.addUser("alice");
    const stream = await openStream(s, await s.login("alice"));
    expect(stream.response.statusCode).toBe(200);
    s.h.bus.publish(id, event("t1"));
    await vi.waitFor(() => expect(stream.text()).toContain('"t1"'));

    // What suspension does: revoke in the database and record it in-process.
    const hashes = s.h.repository.withTransaction((scope) => scope.sessions.revokeAllOf(id, s.clock.now));
    s.revocations.add(hashes);
    s.h.bus.publish(id, event("t2"));
    await stream.ended;
    expect(stream.text()).not.toContain('"t2"');
  });

  it("closes on the next heartbeat when only the database says the session is gone", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const s = await createServerApp();
    open.push(s);
    const id = await s.addUser("alice");
    const stream = await openStream(s, await s.login("alice"));
    vi.advanceTimersByTime(SSE_HEARTBEAT_MS);
    await vi.waitFor(() => expect(stream.text()).toContain(": heartbeat"));

    s.h.db.prepare("UPDATE user SET status = 'suspended' WHERE id = ?").run(id);
    vi.advanceTimersByTime(SSE_HEARTBEAT_MS);
    await stream.ended;
    expect(stream.text().match(/: heartbeat/g)).toHaveLength(1);
  });
});
