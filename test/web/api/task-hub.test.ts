import { describe, expect, it, vi } from "vitest";
import type { TaskDetailDto } from "../../../src/shared/dto/task.ts";
import { ApiClient } from "../../../src/web/api/client.ts";
import { applyEvent, TaskHub } from "../../../src/web/api/task-hub.ts";

const STAGE = { taskId: "t1", attempt: 1, progress: 0, dependencies: [] as never[] };

function snapshot(eventSeq: number): TaskDetailDto {
  return {
    id: "t1",
    kind: "process_content",
    statusProjection: "running",
    createdAt: 1,
    stageRuns: [{ ...STAGE, id: "r1", stage: "source", status: "running" }],
    workUnits: [],
    eventSeq,
  };
}

/** An SSE endpoint whose frames the test pushes, and a snapshot endpoint answering on demand. */
function harness() {
  let push: (text: string) => void = () => undefined;
  const snapshots: Array<(detail: TaskDetailDto) => void> = [];
  vi.stubGlobal("fetch", async (input: string) => {
    if (String(input).endsWith("/api/tasks/events")) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (text) => controller.enqueue(new TextEncoder().encode(text));
        },
      });
      return new Response(body, { status: 200 });
    }
    const detail = await new Promise<TaskDetailDto>((resolve) => snapshots.push(resolve));
    return new Response(JSON.stringify(detail), { status: 200 });
  });
  const frame = (seq: number, event: string, data: object) => push(`event: ${event}\ndata: ${JSON.stringify(data)}\nid: ${seq}\n\n`);
  return { frame, snapshots };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("TaskHub", () => {
  it("reopens the task stream on reconnect and re-reads every watched snapshot", async () => {
    const opened: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      opened.push(String(input));
      if (String(input).endsWith("/api/tasks/events")) {
        return new Response(new ReadableStream({ start: () => undefined }), { status: 200 });
      }
      return new Response(JSON.stringify(snapshot(1)), { status: 200 });
    });
    const client = new ApiClient({ baseUrl: "http://127.0.0.1:1", token: "a" }, "local");
    const hub = new TaskHub(client);
    hub.watch("t1", () => undefined);
    await vi.waitFor(() => expect(opened.filter((url) => url.endsWith("/events"))).toHaveLength(1));
    client.setEndpoint({ baseUrl: "http://127.0.0.1:2", token: "b" });
    hub.reconnect();
    await vi.waitFor(() => expect(opened).toContain("http://127.0.0.1:2/api/tasks/events"));
    await vi.waitFor(() => expect(opened).toContain("http://127.0.0.1:2/api/tasks/t1"));
    hub.close();
  });

  it("stays disconnected on reconnect when nothing is watched", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    new TaskHub(new ApiClient({ baseUrl: "" }, "local")).reconnect();
    await tick();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("subscribes first, then applies only events newer than the snapshot", async () => {
    const { frame, snapshots } = harness();
    const hub = new TaskHub(new ApiClient({ baseUrl: "" }, "local"));
    const changes = vi.fn();
    hub.watch("t1", changes);
    // One read when watching starts, another once the subscription is up.
    await vi.waitFor(() => expect(snapshots).toHaveLength(2));

    // Events racing the snapshot are parked: seq 5 is already inside it, seq 7 is not.
    frame(5, "stage.updated", { stageRun: { ...STAGE, id: "r1", stage: "source", status: "succeeded", progress: 1 } });
    frame(7, "stage.updated", { stageRun: { ...STAGE, id: "r2", stage: "subtitle", status: "running" } });
    await tick();
    for (const resolve of snapshots) resolve(snapshot(6));
    await vi.waitFor(() => expect(hub.view("t1").detail?.eventSeq).toBe(7));
    const detail = hub.view("t1").detail;
    expect(detail?.stageRuns.find((run) => run.id === "r1")?.status).toBe("running");
    expect(detail?.stageRuns.find((run) => run.id === "r2")?.status).toBe("running");

    // Live events after the snapshot: a work unit of this task's run, a stale duplicate.
    frame(8, "workunit.updated", { workUnit: { id: "w1", stageRunId: "r2", key: "k", status: "running", attempt: 1, retryCount: 0 } });
    frame(4, "task.updated", { task: { id: "t1", kind: "process_content", statusProjection: "failed", createdAt: 1 } });
    await vi.waitFor(() => expect(hub.view("t1").detail?.workUnits).toHaveLength(1));
    expect(hub.view("t1").detail?.statusProjection).toBe("running");
    expect(changes).toHaveBeenCalled();
    hub.close();
  });
});

describe("TaskHub overlapping reads", () => {
  it("never lets an older snapshot replace newer state", async () => {
    const { snapshots } = harness();
    const hub = new TaskHub(new ApiClient({ baseUrl: "" }, "local"));
    hub.watch("t1", () => undefined);
    await vi.waitFor(() => expect(snapshots).toHaveLength(2));
    snapshots[1]?.(snapshot(9));
    await vi.waitFor(() => expect(hub.view("t1").detail?.eventSeq).toBe(9));
    snapshots[0]?.(snapshot(3));
    await tick();
    await tick();
    expect(hub.view("t1").detail?.eventSeq).toBe(9);
    hub.close();
  });
});

describe("TaskHub when a task is gone", () => {
  /** Snapshot reads answer from `answers` in order; the stream stays open and silent. */
  function answering(answers: Array<() => Response>) {
    let push: (text: string) => void = () => undefined;
    vi.stubGlobal("fetch", async (input: string) => {
      if (String(input).endsWith("/api/tasks/events")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              push = (text) => controller.enqueue(new TextEncoder().encode(text));
            },
          }),
          { status: 200 },
        );
      }
      return (answers.shift() ?? answers.at(-1) ?? (() => new Response(null, { status: 500 })))();
    });
    return { push: (seq: number, event: string, data: object) => push(`event: ${event}\ndata: ${JSON.stringify(data)}\nid: ${seq}\n\n`) };
  }
  const ok = (eventSeq: number) => () => new Response(JSON.stringify(snapshot(eventSeq)), { status: 200 });
  const notFound = () => new Response(JSON.stringify({ error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } }), { status: 404 });
  const failed = () => new Response(JSON.stringify({ error: { class: "internal", code: "internal", retryDisposition: "never", userMessage: "" } }), { status: 500 });

  it("publishes gone without the old detail when a snapshot read answers 404", async () => {
    answering([ok(1), ok(1), notFound]);
    const hub = new TaskHub(new ApiClient({ baseUrl: "" }, "local"));
    const changes = vi.fn();
    hub.watch("t1", changes);
    await vi.waitFor(() => expect(hub.view("t1").detail?.eventSeq).toBe(1));
    hub.refresh("t1");
    await vi.waitFor(() => expect(hub.view("t1").gone).toBe(true));
    expect(hub.view("t1").detail).toBeUndefined();
    expect(changes).toHaveBeenCalled();
    hub.close();
  });

  it("keeps the last detail on other failures", async () => {
    answering([ok(2), ok(2), failed]);
    const hub = new TaskHub(new ApiClient({ baseUrl: "" }, "local"));
    hub.watch("t1", () => undefined);
    await vi.waitFor(() => expect(hub.view("t1").detail?.eventSeq).toBe(2));
    hub.refresh("t1");
    await vi.waitFor(() => expect(hub.view("t1").error).toBeDefined());
    expect(hub.view("t1").gone).toBeUndefined();
    expect(hub.view("t1").detail?.eventSeq).toBe(2);
    hub.close();
  });

  it("applies no events to a gone task until a snapshot brings it back", async () => {
    const { push } = answering([notFound, notFound, ok(3)]);
    const hub = new TaskHub(new ApiClient({ baseUrl: "" }, "local"));
    hub.watch("t1", () => undefined);
    await vi.waitFor(() => expect(hub.view("t1").gone).toBe(true));
    push(5, "task.updated", { task: { id: "t1", kind: "process_content", statusProjection: "failed", createdAt: 1 } });
    await tick();
    expect(hub.view("t1")).toMatchObject({ gone: true });
    expect(hub.view("t1").detail).toBeUndefined();
    // Restored from the trash: the next read finds the task again.
    hub.refresh("t1");
    await vi.waitFor(() => expect(hub.view("t1").detail?.eventSeq).toBe(3));
    expect(hub.view("t1").gone).toBeUndefined();
    hub.close();
  });
});

describe("applyEvent", () => {
  it("ignores work units of runs the task does not own", () => {
    const detail = snapshot(1);
    const next = applyEvent(detail, { type: "workunit.updated", workUnit: { id: "w9", stageRunId: "other", key: "k", status: "running", attempt: 1, retryCount: 0 } }, 2);
    expect(next).toBe(detail);
  });

  it("clears a cooldown the updated task no longer carries", () => {
    const waiting = { ...snapshot(1), statusProjection: "queued" as const, retryNotBefore: 5_000 };
    const next = applyEvent(waiting, { type: "task.updated", task: { id: "t1", kind: "process_content", statusProjection: "running", createdAt: 1 } }, 2);
    expect(next.retryNotBefore).toBeUndefined();
    expect(next.statusProjection).toBe("running");
  });
});
