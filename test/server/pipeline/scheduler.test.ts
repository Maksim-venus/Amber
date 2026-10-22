import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalFileStore } from "../../../src/server/adapters/file-store/local-file-store.ts";
import { NodeProcessRunner } from "../../../src/server/adapters/process-runner/node-process-runner.ts";
import { amberError } from "../../../src/server/domain/errors.ts";
import type { ModelRef } from "../../../src/server/domain/model-ref.ts";
import { StageParked, stageUnitFailure, UnitDeferred, type StageExecutor } from "../../../src/server/pipeline/executor.ts";
import { latestAttempts } from "../../../src/server/pipeline/projection.ts";
import { nextRetryTime, readyStages, Scheduler } from "../../../src/server/pipeline/scheduler.ts";
import { FakeLlmProvider, reply } from "../../fixtures/llm/fake-llm.ts";
import { lectureTranscripts } from "../../fixtures/transcripts/lecture.ts";
import {
  configureAsr,
  configureLlm,
  createHarness,
  createLocalContent,
  createTaskOfKind,
  gate,
  LOCAL,
  LOCAL_TOKEN,
  silentLogger,
  stageRunsOf,
  stageStatuses,
  taskOf,
  waitFor,
  workUnitsOf,
  type Harness,
} from "../../fixtures/pipeline/harness.ts";
import { countRows, tempDataDir } from "../../tools/sqlite.ts";

const open: Harness[] = [];
function harness(...args: Parameters<typeof createHarness>): Harness {
  const created = createHarness(...args);
  open.push(created);
  return created;
}

afterEach(async () => {
  for (const created of open.splice(0)) {
    await created.close().catch(() => undefined);
  }
});

/** Rejects when the signal aborts; stands for a paid call still in flight. */
const hangUntilAborted = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));

describe("stage graph execution", () => {
  it("runs a platform process_content graph to succeeded, skipping ASR after a valid platform track", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    const result = await h.importContent.import(LOCAL, {
      items: [{ url: "https://www.bilibili.com/video/BV1xx411c7mD" }],
      settings: { modelRef, autoProofread: true },
    });
    const taskId = result.body.taskIds[0] as string;
    h.scheduler.start();
    await h.scheduler.whenIdle();

    expect(stageStatuses(h, taskId)).toEqual({
      source: "succeeded", subtitle: "succeeded", asr: "skipped", proofread: "succeeded", chapter: "succeeded", summary: "succeeded",
    });
    expect(taskOf(h, taskId)).toMatchObject({ statusProjection: "succeeded", finishedAt: expect.any(Number) });
    const content = h.repository.withTransaction((scope) => scope.contents.get(LOCAL.userId, result.body.contentIds[0] as string));
    expect(content?.processingStatus).toBe("succeeded");
  });

  it("skips proofreading when auto-proofread is off", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    const result = await h.importContent.import(LOCAL, {
      items: [{ url: "https://www.bilibili.com/video/BV1xx411c7mD" }],
      settings: { modelRef, autoProofread: false },
    });
    h.scheduler.start();
    await h.scheduler.whenIdle();
    expect(stageStatuses(h, result.body.taskIds[0] as string).proofread).toBe("skipped");
  });

  it("propagates a failure: dependants become skipped(dependency_failed) and the task fails", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    h.executors.source = { run: async () => Promise.reject(amberError("paid_content")) };
    const result = await h.importContent.import(LOCAL, { items: [{ url: "https://www.bilibili.com/video/BV1xx411c7mD" }], settings: { modelRef, autoProofread: true } });
    const taskId = result.body.taskIds[0] as string;
    h.scheduler.start();
    await h.scheduler.whenIdle();

    const runs = latestAttempts(stageRunsOf(h, taskId));
    expect(runs.find((run) => run.stage === "source")).toMatchObject({ status: "failed", error: { class: "paid_content" } });
    for (const run of runs.filter((candidate) => candidate.stage !== "source")) {
      expect(run).toMatchObject({ status: "skipped", resultJson: JSON.stringify({ reasons: ["dependency_failed"] }) });
    }
    expect(taskOf(h, taskId).statusProjection).toBe("failed");
  });

  it("retries safe / policy failures up to RETRY_MAX and then fails with the upstream error", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    let attempts = 0;
    h.executors.summary = {
      async run(context) {
        await context.runUnit({
          key: "summary:final",
          inputDigest: "in",
          run: async () => {
            attempts += 1;
            throw amberError("llm_rate_limited");
          },
        });
        return {};
      },
    };
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef });
    h.scheduler.start();
    await h.scheduler.whenIdle();
    expect(attempts).toBe(4);
    // Each wait was persisted on the unit and woken by the scheduler: 2 s, 4 s, 8 s.
    expect(h.waits.filter((ms) => ms > 0)).toHaveLength(3);
    expect(stageStatuses(h, taskId).summary).toBe("failed");
    expect(workUnitsOf(h, taskId)[0]).toMatchObject({ status: "failed", retryCount: 3, error: { class: "llm_rate_limited" } });
  });

  it("fails a stage without a registered executor instead of hanging", async () => {
    const h = harness({ executors: {} });
    const taskId = createTaskOfKind(h, "cache_media", {});
    h.scheduler.start();
    await h.scheduler.whenIdle();
    expect(latestAttempts(stageRunsOf(h, taskId))[0]).toMatchObject({ status: "failed", error: { class: "internal" } });
  });

  describe("reported progress", () => {
    /** Runs `regenerate_summary` whose stage reports `values`, returning the progress of every summary `stage.updated` event and what was stored meanwhile. */
    async function progressOf(values: number[]): Promise<{ events: number[]; stored: number[] }> {
      const h = harness();
      const modelRef = configureLlm(h);
      const stored: number[] = [];
      h.executors.summary = {
        async run(context) {
          for (const value of values) {
            context.reportProgress(value);
            stored.push(latestAttempts(stageRunsOf(h, context.task.id)).find((run) => run.stage === "summary")?.progress ?? Number.NaN);
          }
          return {};
        },
      };
      const events: number[] = [];
      const unsubscribe = h.bus.subscribe(({ event }) => {
        if (event.type === "stage.updated" && event.stageRun.stage === "summary") {
          events.push(event.stageRun.progress);
        }
      });
      createTaskOfKind(h, "regenerate_summary", { modelRef });
      h.scheduler.start();
      await h.scheduler.whenIdle();
      unsubscribe();
      return { events, stored };
    }

    it("never moves backwards within a run, and success still ends at 1", async () => {
      const { events, stored } = await progressOf([0.2, 0.6, 0.3, 0.7]);
      expect(stored).toEqual([0.2, 0.6, 0.6, 0.7]);
      expect(events.at(-1)).toBe(1);
      const running = events.slice(0, -1);
      expect(running).toEqual([...running].sort((a, b) => a - b));
    });

    it("stores whole percents, clamped to [0, 1]", async () => {
      const { stored } = await progressOf([0.123, 0.29, 0.4999, 1.5]);
      expect(stored).toEqual([0.12, 0.29, 0.49, 1]);
    });

    it("writes nothing and publishes nothing while the rounded value does not change", async () => {
      const { events, stored } = await progressOf([0.401, 0.402, 0.409, 0.41, -1]);
      expect(stored).toEqual([0.4, 0.4, 0.4, 0.41, 0.41]);
      // Past the stage's own start events: the two distinct values, then success.
      expect(events.filter((progress) => progress > 0)).toEqual([0.4, 0.41, 1]);
    });
  });

  it("holds pipeline slots FIFO by createdAt up to CONCURRENCY_PIPELINE", async () => {
    const h = harness({ overrides: { concurrencyPipeline: 1 } });
    const modelRef = configureLlm(h);
    const order: string[] = [];
    const release = gate();
    h.executors.summary = {
      async run(context) {
        order.push(context.task.id);
        if (order.length === 1) {
          await release.promise;
        }
        return {};
      },
    };
    const second = createTaskOfKind(h, "regenerate_summary", { modelRef }, { createdAt: 2000 });
    const first = createTaskOfKind(h, "regenerate_summary", { modelRef }, { createdAt: 1000 });
    h.scheduler.start();
    await waitFor(() => order.length === 1);
    expect(order).toEqual([first]);
    expect(taskOf(h, second).statusProjection).toBe("queued");
    release.open();
    await h.scheduler.whenIdle();
    expect(order).toEqual([first, second]);
  });
});

describe("concurrency", () => {
  it("lets a new model lane send LLM_WINDOW_INITIAL calls at first and more only after successes", async () => {
    const llm = new FakeLlmProvider();
    llm.script(...Array.from({ length: 8 }, () => ({ events: reply("ok"), delayMs: 20 })));
    let inFlight = 0;
    let completed = 0;
    const atSend: Array<{ inFlight: number; completed: number }> = [];
    llm.onActive = (delta) => {
      if (delta === 1) {
        atSend.push({ inFlight, completed });
      } else {
        completed += 1;
      }
      inFlight += delta;
    };
    const h = harness({ overrides: { concurrencyPipeline: 2 }, llmProviders: [llm] });
    const modelRef = configureLlm(h);
    h.executors.summary = {
      async run(context) {
        await Promise.all(
          [1, 2, 3, 4].map(() =>
            context.llm.complete(
              { modelRef, system: context.task.id, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
              { feature: "summary" },
            ),
          ),
        );
        return {};
      },
    };
    const ids = [1, 2].map((n) => createTaskOfKind(h, "regenerate_summary", { modelRef }, { createdAt: n }));
    h.scheduler.start();
    await h.scheduler.whenIdle();
    expect(atSend).toHaveLength(8);
    // The first LLM_WINDOW_INITIAL (3) go out at once; every later one only after a success widened the window.
    expect(atSend.slice(0, 3).every((send) => send.completed === 0)).toBe(true);
    expect(atSend.slice(3).every((send) => send.completed >= 1)).toBe(true);
    expect(Math.max(...atSend.map((send) => send.inFlight + 1))).toBeGreaterThan(3);
    expect(ids.map((id) => taskOf(h, id).statusProjection)).toEqual(["succeeded", "succeeded"]);
    const usage = h.repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId));
    expect(usage).toHaveLength(8);
    expect(usage.every((row) => row.feature === "summary" && row.outcome === "succeeded")).toBe(true);
  });

  it("shares LLM slots among Tasks: a third Task's first request goes out before the first two finish", async () => {
    const llm = new FakeLlmProvider();
    llm.script(...Array.from({ length: 12 }, () => ({ events: reply("ok"), delayMs: 20 })));
    const h = harness({ overrides: { concurrencyPipeline: 3 }, llmProviders: [llm] });
    const modelRef = configureLlm(h);
    h.executors.summary = {
      async run(context) {
        // Four requests at once, like the chunks of one stage.
        await Promise.all(
          [1, 2, 3, 4].map(() =>
            context.llm.complete(
              { modelRef, system: context.task.id, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
              { feature: "summary" },
            ),
          ),
        );
        return {};
      },
    };
    const ids = [1, 2, 3].map((n) => createTaskOfKind(h, "regenerate_summary", { modelRef }, { createdAt: n }));
    h.scheduler.start();
    await h.scheduler.whenIdle();
    const callers = llm.calls.map((call) => call.request.system);
    expect(callers).toHaveLength(12);
    const third = ids[2] as string;
    const lastOfFirstTwo = Math.max(callers.lastIndexOf(ids[0] as string), callers.lastIndexOf(ids[1] as string));
    // In plain Task order the third Task would wait for all eight requests of the first two.
    // The first Task may take the lane's first three sends while it asks alone; once the
    // others ask, each new send goes to the Task holding the fewest.
    expect(callers.indexOf(third)).toBeLessThan(lastOfFirstTwo);
    expect(callers.indexOf(third)).toBeLessThan(5);
    expect(ids.map((id) => taskOf(h, id).statusProjection)).toEqual(["succeeded", "succeeded", "succeeded"]);
  });

  it("lets a single-call Task through while an older Task still has many chunks waiting", async () => {
    const llm = new FakeLlmProvider();
    llm.script(...Array.from({ length: 11 }, () => ({ events: reply("ok"), delayMs: 20 })));
    const h = harness({ overrides: { concurrencyPipeline: 2 }, llmProviders: [llm] });
    const modelRef = configureLlm(h);
    const chunks = 10;
    h.executors.summary = {
      async run(context) {
        const calls = context.task.createdAt === 1 ? chunks : 1;
        await Promise.all(
          Array.from({ length: calls }, (_, n) =>
            context.llm.complete(
              { modelRef, system: `${context.task.id}:${n}`, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
              { feature: "summary" },
            ),
          ),
        );
        return {};
      },
    };
    const big = createTaskOfKind(h, "regenerate_summary", { modelRef }, { createdAt: 1 });
    const small = createTaskOfKind(h, "regenerate_summary", { modelRef }, { createdAt: 2 });
    h.scheduler.start();
    await h.scheduler.whenIdle();
    const callers = llm.calls.map((call) => String(call.request.system).split(":")[0]);
    expect(callers.filter((id) => id === big)).toHaveLength(chunks);
    // The small Task's only request is sent among the first ones the lane admits, not the eleventh.
    expect(callers.indexOf(small)).toBeLessThanOrEqual(3);
    expect([big, small].map((id) => taskOf(h, id).statusProjection)).toEqual(["succeeded", "succeeded"]);
  });

  it("starts a queued Task as soon as the pipeline limit is raised, and none while it is lowered below the running ones", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    h.settings.patch(LOCAL, { concurrencyPipeline: 2 });
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof gate>>();
    h.executors.summary = {
      async run(context) {
        started.push(context.task.id);
        await (gates.get(context.task.id) as ReturnType<typeof gate>).promise;
        return {};
      },
    };
    const create = (createdAt: number): string => {
      const id = createTaskOfKind(h, "regenerate_summary", { modelRef }, { createdAt });
      gates.set(id, gate());
      return id;
    };
    const finish = async (id: string): Promise<void> => {
      gates.get(id)?.open();
      await waitFor(() => taskOf(h, id).statusProjection === "succeeded" && !h.scheduler.isExecuting(id));
      // Give the scheduling pass the finished driver triggers time to run.
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    const [first, second, third] = [1, 2, 3].map(create) as [string, string, string];
    h.scheduler.start();
    await waitFor(() => started.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toEqual([first, second]);
    expect(taskOf(h, third).statusProjection).toBe("queued");

    h.settings.patch(LOCAL, { concurrencyPipeline: 3 });
    await waitFor(() => started.length === 3);
    expect(started).toEqual([first, second, third]);

    // Lowering never interrupts: all three keep running, and nothing new starts until none is left running.
    h.settings.patch(LOCAL, { concurrencyPipeline: 1 });
    const [fourth, fifth] = [4, 5].map(create) as [string, string];
    h.scheduler.kick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([first, second, third].map((id) => h.scheduler.isExecuting(id))).toEqual([true, true, true]);
    await finish(first);
    await finish(second);
    expect(started).toEqual([first, second, third]);
    await finish(third);
    await waitFor(() => started.length === 4);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toEqual([first, second, third, fourth]);
    await finish(fourth);
    await waitFor(() => started.length === 5);
    expect(started.at(-1)).toBe(fifth);
    await finish(fifth);
    await h.scheduler.whenIdle();
  });

  it("fails an LLM call whose protocol has no adapter as internal, recording nothing", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    h.executors.summary = {
      async run(context) {
        await context.llm.complete({ modelRef, system: "", messages: [] }, { feature: "summary" });
        return {};
      },
    };
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef });
    h.scheduler.start();
    await h.scheduler.whenIdle();
    // The harness gateway has no adapter for the profile's protocol.
    expect(latestAttempts(stageRunsOf(h, taskId)).find((run) => run.stage === "summary")).toMatchObject({ status: "failed", error: { class: "internal" } });
    expect(h.repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId))).toEqual([]);
  });

  it("keeps managed heavy jobs at or below the task count, even when one stage starts several", async () => {
    const h = harness({ overrides: { concurrencyPipeline: 2 } });
    const modelRef = configureLlm(h);
    let inFlight = 0;
    let peak = 0;
    const heavyJob = async (): Promise<void> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
    };
    h.executors.summary = {
      async run(context) {
        // Like proofreading clipping one chunk's audio per call: several heavy jobs of one stage.
        await Promise.all([1, 2, 3].map(() => context.withHeavySlot(heavyJob)));
        return {};
      },
    };
    const ids = [1, 2].map((n) => createTaskOfKind(h, "regenerate_summary", { modelRef }, { createdAt: n }));
    h.scheduler.start();
    await h.scheduler.whenIdle();
    expect(peak).toBe(2);
    expect(ids.map((id) => taskOf(h, id).statusProjection)).toEqual(["succeeded", "succeeded"]);
  });

  it("runs heavy stages under the heavy-job governor, whose capacity is the task count", async () => {
    const h = harness({ overrides: { concurrencyPipeline: 1 } });
    let inFlight = 0;
    let peak = 0;
    h.executors.media = {
      async run() {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return {};
      },
    };
    const first = createTaskOfKind(h, "process_content", { autoProofread: false }, { createdAt: 1 });
    const second = createTaskOfKind(h, "process_content", { autoProofread: false }, { createdAt: 2 });
    h.scheduler.start();
    await h.scheduler.whenIdle();
    expect(peak).toBe(1);
    // Local media needs ASR, which is not configured: both tasks end up waiting for it.
    expect([stageStatuses(h, first).media, stageStatuses(h, second).asr]).toEqual(["succeeded", "waiting_configuration"]);
  });
});

describe("start-up order", () => {
  it("ignores kicks before start, then recovers before scheduling anything", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef });
    h.scheduler.kick();
    await h.scheduler.whenIdle();
    expect(stageStatuses(h, taskId).summary).toBe("pending");
    h.scheduler.start();
    await h.scheduler.whenIdle();
    expect(stageStatuses(h, taskId).summary).toBe("succeeded");
  });
});

describe("crash recovery reruns only unfinished work units", () => {
  it("restarts on the same database without re-running completed units and restores DB-only results", async () => {
    const calls = [0, 0, 0, 0, 0];
    const thirdStarted = gate();
    let hangThird = true;
    const summary: StageExecutor = {
      async run(context) {
        const parts: unknown[] = [];
        for (let n = 1; n <= 4; n += 1) {
          parts.push(
            await context.runUnit({
              key: `summary:partial:${n}`,
              inputDigest: `partial-input-${n}`,
              run: async (signal) => {
                calls[n] = (calls[n] ?? 0) + 1;
                if (n === 3 && hangThird) {
                  thirdStarted.open();
                  return hangUntilAborted(signal);
                }
                return { n, text: `partial ${n}` };
              },
            }),
          );
        }
        return { resultJson: { parts } };
      },
    };

    const first = harness({ executors: { summary } });
    const modelRef = configureLlm(first);
    const taskId = createTaskOfKind(first, "regenerate_summary", { modelRef });
    first.scheduler.start();
    await thirdStarted.promise;
    expect(workUnitsOf(first, taskId).map((unit) => unit.status)).toEqual(["succeeded", "succeeded", "running"]);
    // The process "dies": executions are aborted and nothing after that is written.
    await first.close();

    hangThird = false;
    const second = harness({ file: first.file, executors: { summary } });
    expect(second.tasks.get(LOCAL, taskId).stageRuns[0]?.status).toBe("running");
    second.scheduler.start();
    await second.scheduler.whenIdle();

    expect(calls.slice(1)).toEqual([1, 1, 2, 1]);
    const [run] = stageRunsOf(second, taskId);
    expect(run).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(JSON.parse(run?.resultJson ?? "null")).toEqual({
      parts: [1, 2, 3, 4].map((n) => ({ n, text: `partial ${n}` })),
    });
    expect(workUnitsOf(second, taskId).map((unit) => [unit.key, unit.status, unit.attempt])).toEqual([
      ["summary:partial:1", "succeeded", 1],
      ["summary:partial:2", "succeeded", 1],
      ["summary:partial:3", "succeeded", 2],
      ["summary:partial:4", "succeeded", 1],
    ]);
    expect(countRows(second.db, "work_unit_result")).toBe(4);
    expect(taskOf(second, taskId).statusProjection).toBe("succeeded");
  });

  it("re-runs a succeeded unit whose persisted result no longer matches its digest", async () => {
    let calls = 0;
    const summary: StageExecutor = {
      async run(context) {
        await context.runUnit({ key: "summary:final", inputDigest: "in", run: async () => ({ calls: ++calls }) });
        return {};
      },
    };
    const h = harness({ executors: { summary } });
    const modelRef = configureLlm(h);
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef });
    h.scheduler.start();
    await h.scheduler.whenIdle();
    h.db.prepare("UPDATE work_unit_result SET payload_json = '{\"calls\":99}'").run();
    h.db.prepare("UPDATE stage_run SET status = 'interrupted'").run();
    h.db.prepare("UPDATE task SET status_projection = 'queued', finished_at = NULL").run();
    h.scheduler.kick();
    await h.scheduler.whenIdle();
    expect(calls).toBe(2);
    expect(taskOf(h, taskId).statusProjection).toBe("succeeded");
  });
});

describe("file-backed units", () => {
  it("are reused on resume only while the output file still has the recorded digest", async () => {
    let calls = 0;
    const dir = tempDataDir("amber-file-units-");
    const files = new LocalFileStore(dir);
    const summary: StageExecutor = {
      async run(context) {
        await context.runUnit({
          key: "summary:file",
          inputDigest: "in",
          storage: "file",
          run: async () => {
            calls += 1;
            const stored = await files.writeAtomic("tmp/tasks/unit/out.json", Buffer.from(`{"calls":${calls}}`));
            return { outputRef: "tmp/tasks/unit/out.json", outputDigest: stored.digest };
          },
        });
        return {};
      },
    };
    const h = harness({ executors: { summary }, files });
    const modelRef = configureLlm(h);
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef });
    const resume = async () => {
      h.db.prepare("UPDATE stage_run SET status = 'interrupted'").run();
      h.db.prepare("UPDATE task SET status_projection = 'queued', finished_at = NULL").run();
      h.scheduler.kick();
      await h.scheduler.whenIdle();
    };
    h.scheduler.start();
    await h.scheduler.whenIdle();
    await resume();
    expect(calls).toBe(1);
    writeFileSync(join(dir, "tmp", "tasks", "unit", "out.json"), "tampered");
    await resume();
    expect(calls).toBe(2);
    expect(taskOf(h, taskId).statusProjection).toBe("succeeded");
  });
});

describe("cache gate", () => {
  it("starts nothing while the exclusive cache lease is held and catches up once it is released", async () => {
    const h = harness();
    const modelRef = configureLlm(h);
    const release = h.gate.tryExclusive("cache_migration") as () => void;
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef });
    h.scheduler.start();
    await h.scheduler.whenIdle();
    expect(taskOf(h, taskId).statusProjection).toBe("queued");
    expect(h.executors.summary && "calls" in h.executors.summary ? h.executors.summary.calls : -1).toBe(0);
    release();
    h.scheduler.kick();
    await h.scheduler.whenIdle();
    expect(taskOf(h, taskId).statusProjection).toBe("succeeded");
    // Drivers release their shared lease when they finish.
    expect(h.gate.tryExclusive("cache_migration")).toBeDefined();
  });

  it("holds a shared lease for the whole run of a Task", async () => {
    const h = harness({ executors: {} });
    const modelRef = configureLlm(h);
    const running = gate();
    let exclusiveDuringRun: unknown = "unset";
    h.executors.summary = {
      async run() {
        exclusiveDuringRun = h.gate.tryExclusive("cache_migration");
        await running.promise;
        return {};
      },
    };
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef });
    h.scheduler.start();
    await waitFor(() => exclusiveDuringRun !== "unset");
    expect(exclusiveDuringRun).toBeUndefined();
    running.open();
    await h.scheduler.whenIdle();
    expect(taskOf(h, taskId).statusProjection).toBe("succeeded");
    expect(h.gate.tryExclusive("cache_migration")).toBeDefined();
  });

  it("verifies a unit stored in the cache against the cache store, not the data store", async () => {
    let calls = 0;
    const dataDir = tempDataDir("amber-split-data-");
    const cacheDir = tempDataDir("amber-split-cache-");
    const data = new LocalFileStore(dataDir);
    const cache = new LocalFileStore(cacheDir);
    const summary: StageExecutor = {
      async run(context) {
        await context.runUnit({
          key: "summary:cache-file",
          inputDigest: "in",
          storage: "file",
          store: "cache",
          run: async () => {
            calls += 1;
            const stored = await cache.writeAtomic("assets/u/c/video", Buffer.from(`video-${calls}`));
            return { outputRef: "assets/u/c/video", outputDigest: stored.digest };
          },
        });
        return {};
      },
    };
    const h = harness({ executors: { summary } });
    const scheduler = new Scheduler({
      repository: h.repository,
      secrets: h.secrets,
      bus: h.bus,
      executors: { summary },
      settings: h.settings,
      disk: h.disk,
      gate: h.gate,
      media: { data, cache },
      mode: "local",
      logger: silentLogger,
      llm: h.llm,
      newId: h.newId,
      sleep: async () => undefined,
    });
    const modelRef = configureLlm(h);
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef });
    const resume = async () => {
      h.db.prepare("UPDATE stage_run SET status = 'interrupted'").run();
      h.db.prepare("UPDATE task SET status_projection = 'queued', finished_at = NULL").run();
      scheduler.kick();
      await scheduler.whenIdle();
    };
    scheduler.start();
    await scheduler.whenIdle();
    expect(calls).toBe(1);
    // The file is in the cache store only; a check against the data store would re-run.
    expect(await data.digest("assets/u/c/video")).toBeNull();
    await resume();
    expect(calls).toBe(1);
    writeFileSync(join(cacheDir, "assets", "u", "c", "video"), "tampered");
    await resume();
    expect(calls).toBe(2);
    expect(taskOf(h, taskId).statusProjection).toBe("succeeded");
    await scheduler.stop();
  });
});

describe("outcome_unknown parks the unit until the user confirms", () => {
  it("stops in waiting_user_action, never re-sends on its own (even across a restart), and continues after confirm-resend", async () => {
    let calls = 0;
    const summary: StageExecutor = {
      async run(context) {
        await context.runUnit({
          key: "summary:final",
          inputDigest: "in",
          run: async () => {
            calls += 1;
            if (calls === 1) {
              throw amberError("llm_outcome_unknown");
            }
            return { ok: true };
          },
        });
        return {};
      },
    };
    const h = harness({ executors: { summary } });
    const modelRef = configureLlm(h);
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef });
    h.scheduler.start();
    await h.scheduler.whenIdle();

    const [unit] = workUnitsOf(h, taskId);
    expect(unit).toMatchObject({ status: "waiting_user_action", error: { class: "llm_outcome_unknown", retryDisposition: "outcome_unknown" } });
    expect(stageStatuses(h, taskId).summary).toBe("running");
    expect(taskOf(h, taskId).statusProjection).toBe("waiting");

    h.scheduler.kick();
    await h.scheduler.whenIdle();
    await h.close();
    const restarted = harness({ file: h.file, executors: { summary } });
    restarted.scheduler.start();
    await restarted.scheduler.whenIdle();
    expect(calls).toBe(1);
    expect(workUnitsOf(restarted, taskId)[0]?.status).toBe("waiting_user_action");
    expect(taskOf(restarted, taskId).statusProjection).toBe("waiting");

    const { app } = await restarted.app();
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/work-units/${unit?.id as string}/confirm-resend`,
      headers: { authorization: `Bearer ${LOCAL_TOKEN}` },
    });
    expect(confirmed.statusCode).toBe(202);
    expect(confirmed.json()).toEqual({ taskId });
    await restarted.scheduler.whenIdle();
    expect(calls).toBe(2);
    expect(workUnitsOf(restarted, taskId)[0]).toMatchObject({ status: "succeeded", attempt: 2 });
    expect(taskOf(restarted, taskId).statusProjection).toBe("succeeded");
  });

  it("does not re-run a unit that already failed in this attempt when the stage re-enters after confirm-resend, only in a new attempt", async () => {
    let mismatchCalls = 0;
    let unknownCalls = 0;
    let mismatchFails = true;
    const summary: StageExecutor = {
      async run(context) {
        const settled = await Promise.allSettled([
          context.runUnit({
            key: "summary:partial:mismatch",
            inputDigest: "mismatch-input",
            run: async () => {
              mismatchCalls += 1;
              if (mismatchFails) {
                throw amberError("output_mismatch", "answer rejected");
              }
              return { ok: "mismatch" };
            },
          }),
          context.runUnit({
            key: "summary:partial:unknown",
            inputDigest: "unknown-input",
            run: async () => {
              unknownCalls += 1;
              if (unknownCalls === 1) {
                throw amberError("llm_outcome_unknown");
              }
              return { ok: "unknown" };
            },
          }),
        ]);
        const failure = stageUnitFailure(settled);
        if (failure !== undefined) {
          throw failure;
        }
        return {};
      },
    };
    const h = harness({ executors: { summary } });
    const modelRef = configureLlm(h);
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef });
    h.scheduler.start();
    await h.scheduler.whenIdle();

    // Re-asked at once after each output_mismatch until its retries are spent.
    expect(mismatchCalls).toBe(4);
    const failed = workUnitsOf(h, taskId).find((unit) => unit.key === "summary:partial:mismatch");
    expect(failed).toMatchObject({ status: "failed", attempt: 1, retryCount: 3, error: { class: "output_mismatch" } });
    const parked = workUnitsOf(h, taskId).find((unit) => unit.key === "summary:partial:unknown");
    expect(parked?.status).toBe("waiting_user_action");
    expect(stageStatuses(h, taskId).summary).toBe("running");

    const failedUnitEvents: string[] = [];
    const unsubscribe = h.bus.subscribe(({ event }) => {
      if (event.type === "workunit.updated" && event.workUnit.id === failed?.id) {
        failedUnitEvents.push(event.workUnit.status);
      }
    });
    h.tasks.confirmResend(LOCAL, taskId, parked?.id as string);
    await h.scheduler.whenIdle();
    unsubscribe();

    expect(unknownCalls).toBe(2);
    expect(mismatchCalls).toBe(4);
    expect(failedUnitEvents).toEqual([]);
    expect(workUnitsOf(h, taskId).find((unit) => unit.id === failed?.id)).toEqual(failed);
    const [firstRun] = stageRunsOf(h, taskId);
    expect(firstRun).toMatchObject({ attempt: 1, status: "failed" });
    expect(firstRun?.error).toEqual(failed?.error);
    expect(taskOf(h, taskId).statusProjection).toBe("failed");

    mismatchFails = false;
    h.tasks.retryStage(LOCAL, taskId, { stage: "summary" });
    await h.scheduler.whenIdle();
    expect(mismatchCalls).toBe(5);
    // The unit that succeeded after confirmation is taken over, not sent again.
    expect(unknownCalls).toBe(2);
    const runs = stageRunsOf(h, taskId);
    expect(runs.map((run) => [run.attempt, run.status])).toEqual([[1, "failed"], [2, "succeeded"]]);
    expect(workUnitsOf(h, taskId).filter((unit) => unit.stageRunId === runs[1]?.id).find((unit) => unit.key === "summary:partial:mismatch")).toMatchObject({
      status: "succeeded",
      attempt: 1,
      retryCount: 0,
    });
    expect(taskOf(h, taskId).statusProjection).toBe("succeeded");
  });
});

describe.skipIf(process.platform === "win32")("cancellation kills the whole process tree", () => {
  it("leaves no live process in the child's process group and records cancelled states", async () => {
    const groups: number[] = [];
    const summary: StageExecutor = {
      async run(context) {
        await new NodeProcessRunner().run(
          { command: "/bin/sh", args: ["-c", "echo $$; sleep 30 & sleep 30"], env: {} },
          { signal: context.signal, onStdoutLine: (line) => groups.push(Number(line)) },
        );
        return {};
      },
    };
    const h = harness({ executors: { summary } });
    const modelRef = configureLlm(h);
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef });
    h.scheduler.start();
    await waitFor(() => groups.length === 1);
    const pgid = groups[0] as number;
    expect(groupAlive(pgid)).toBe(true);

    const detail = h.tasks.cancel(LOCAL, taskId);
    expect(detail.statusProjection).toBe("cancelled");
    await waitFor(() => !groupAlive(pgid), 3000);
    await h.scheduler.whenIdle();
    expect(stageStatuses(h, taskId).summary).toBe("cancelled");
    expect(taskOf(h, taskId)).toMatchObject({ statusProjection: "cancelled", finishedAt: expect.any(Number) });
  });
});

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

describe("publication is atomic", () => {
  function publishingExecutor(contentId: string, inject: boolean): StageExecutor {
    const fixture = lectureTranscripts(contentId);
    return {
      async run() {
        return {
          resultJson: { reasons: [] },
          publish(scope) {
            scope.transcripts.insertRevision(LOCAL.userId, fixture.platform.revision, fixture.platform.segments);
            scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, fixture.platform.revision.id, 2);
            if (inject) {
              throw new Error("injected failure inside the publication transaction");
            }
          },
        };
      },
    };
  }

  it("rolls back revision, segments, pointer and terminal state together when publication fails", async () => {
    const h = harness({ executors: {} });
    const modelRef = configureLlm(h);
    const contentId = createLocalContent(h);
    h.executors.summary = publishingExecutor(contentId, true);
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef }, { contentId });
    h.scheduler.start();
    await h.scheduler.whenIdle();

    expect(countRows(h.db, "transcript_revision")).toBe(0);
    expect(countRows(h.db, "transcript_segment")).toBe(0);
    expect(h.repository.withTransaction((scope) => scope.contents.get(LOCAL.userId, contentId))?.primaryTranscriptRevisionId).toBeUndefined();
    expect(latestAttempts(stageRunsOf(h, taskId))[0]).toMatchObject({ status: "failed", error: { class: "internal" } });
    expect(taskOf(h, taskId).statusProjection).toBe("failed");
  });

  it("commits them together when publication succeeds", async () => {
    const h = harness({ executors: {} });
    const modelRef = configureLlm(h);
    const contentId = createLocalContent(h);
    h.executors.summary = publishingExecutor(contentId, false);
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef }, { contentId });
    h.scheduler.start();
    await h.scheduler.whenIdle();

    expect(countRows(h.db, "transcript_revision")).toBe(1);
    expect(countRows(h.db, "transcript_segment")).toBe(4);
    expect(h.repository.withTransaction((scope) => scope.contents.get(LOCAL.userId, contentId))?.primaryTranscriptRevisionId).toBeDefined();
    expect(stageStatuses(h, taskId).summary).toBe("succeeded");
  });
});

/**
 * A paid, file-backed ASR-like unit: `run` commits its output at the unit's checkpoint ref
 * under the Task's scratch directory, then the stage reads it back.
 */
function paidFileStage(files: LocalFileStore, options: { onRun: (unit: { id: string }, signal: AbortSignal) => Promise<void>; afterUnit?: () => void }) {
  let calls = 0;
  const executor: StageExecutor = {
    async run(context) {
      const checkpointRef = (unit: { id: string }) => `tmp/tasks/${context.task.id}/asr-${unit.id}.json`;
      const output = await context.runUnit({
        key: "asr:submit",
        inputDigest: "audio-digest",
        storage: "file",
        billing: "asr",
        checkpointRef,
        run: async (signal, unit) => {
          calls += 1;
          await options.onRun(unit, signal);
          const stored = await files.writeAtomic(checkpointRef(unit), Buffer.from(`{"unit":"${unit.id}"}`));
          return { outputRef: checkpointRef(unit), outputDigest: stored.digest };
        },
      });
      options.afterUnit?.();
      return { resultJson: { outputRef: output.outputRef } };
    },
  };
  return { executor, calls: () => calls };
}

describe("an unknown-outcome paid call waits for the user", () => {
  it("parks the unit, projects the task as waiting and never re-sends on its own", async () => {
    const files = new LocalFileStore(tempDataDir("amber-paid-"));
    const stage = paidFileStage(files, { onRun: async () => Promise.reject(amberError("asr_timeout")) });
    const h = harness({ executors: { asr: stage.executor }, files });
    const asrModelRef = configureAsr(h);
    const taskId = createTaskOfKind(h, "retranscribe", { asrModelRef });
    h.scheduler.start();
    await h.scheduler.whenIdle();
    h.scheduler.kick();
    await h.scheduler.whenIdle();

    expect(stage.calls()).toBe(1);
    expect(workUnitsOf(h, taskId)[0]).toMatchObject({ status: "waiting_user_action", billing: "asr", error: { class: "asr_timeout", retryDisposition: "outcome_unknown" } });
    expect(stageStatuses(h, taskId).asr).toBe("running");
    expect(taskOf(h, taskId).statusProjection).toBe("waiting");
  });
});

describe("a crash during a paid call", () => {
  async function crashDuringCall(writeCheckpointBeforeCrash: boolean) {
    const dir = tempDataDir("amber-paid-crash-");
    const files = new LocalFileStore(dir);
    const started = gate();
    let crash = true;
    const stage = paidFileStage(files, {
      onRun: async (unit, signal) => {
        if (!crash) {
          return;
        }
        if (writeCheckpointBeforeCrash) {
          // The response reached the disk; the process dies before the unit is recorded.
          await files.writeAtomic(`tmp/tasks/${taskId}/asr-${unit.id}.json`, Buffer.from(`{"unit":"${unit.id}"}`));
        }
        started.open();
        await hangUntilAborted(signal);
      },
    });
    const first = harness({ executors: { asr: stage.executor }, files });
    const asrModelRef = configureAsr(first);
    const taskId = createTaskOfKind(first, "retranscribe", { asrModelRef });
    first.scheduler.start();
    await started.promise;
    await first.close();
    crash = false;

    const second = harness({ file: first.file, executors: { asr: stage.executor }, files });
    second.scheduler.start();
    await second.scheduler.whenIdle();
    const [parked] = workUnitsOf(second, taskId);
    expect(parked).toMatchObject({ status: "waiting_user_action", error: { class: "asr_timeout" } });
    expect(taskOf(second, taskId).statusProjection).toBe("waiting");
    expect(stage.calls()).toBe(1);

    second.tasks.confirmResend(LOCAL, taskId, parked?.id as string);
    await second.scheduler.whenIdle();
    return { second, taskId, stage, unitId: parked?.id as string };
  }

  it("publishes from a committed checkpoint after confirm-resend without calling out again", async () => {
    const { second, taskId, stage, unitId } = await crashDuringCall(true);
    expect(stage.calls()).toBe(1);
    expect(workUnitsOf(second, taskId)[0]).toMatchObject({ id: unitId, status: "succeeded", outputRef: `tmp/tasks/${taskId}/asr-${unitId}.json` });
    expect(workUnitsOf(second, taskId)[0]?.error).toBeUndefined();
    const [run] = stageRunsOf(second, taskId);
    expect(run).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(JSON.parse(run?.resultJson ?? "null")).toEqual({ outputRef: `tmp/tasks/${taskId}/asr-${unitId}.json` });
    expect(taskOf(second, taskId).statusProjection).toBe("succeeded");
  });

  it("re-sends after confirmation when no checkpoint was committed", async () => {
    const { second, taskId, stage } = await crashDuringCall(false);
    expect(stage.calls()).toBe(2);
    expect(workUnitsOf(second, taskId)[0]).toMatchObject({ status: "succeeded", attempt: 2 });
    expect(taskOf(second, taskId).statusProjection).toBe("succeeded");
  });
});

describe("crash recovery parks only LLM units that were admitted", () => {
  it("keeps units waiting for admission pending, so only the units in a call wait for confirmation", async () => {
    const hangingStep = (_request: unknown, opts: { signal: AbortSignal }) =>
      (async function* () {
        await hangUntilAborted(opts.signal);
      })();
    // The lane admits LLM_WINDOW_INITIAL (3) calls at first; all three hang.
    const hung = new FakeLlmProvider().script(hangingStep, hangingStep, hangingStep);
    const summary: StageExecutor = {
      async run(context) {
        const modelRef = context.modelRef as ModelRef;
        const settled = await Promise.allSettled(
          [1, 2, 3, 4, 5].map((n) =>
            context.runUnit({
              key: `summary:partial:${n}`,
              inputDigest: `partial-input-${n}`,
              billing: "llm",
              run: async (_signal, unit) => {
                const completion = await context.llm.complete(
                  { modelRef, system: `partial ${n}`, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
                  { feature: "summary", workUnitId: unit.id },
                );
                return completion.text;
              },
            }),
          ),
        );
        if (settled.some((result) => result.status === "rejected" && result.reason instanceof StageParked)) {
          throw new StageParked();
        }
        const failure = settled.find((result) => result.status === "rejected");
        if (failure !== undefined) {
          throw (failure as PromiseRejectedResult).reason;
        }
        return { resultJson: { parts: settled.map((result) => (result as PromiseFulfilledResult<unknown>).value) } };
      },
    };

    const first = harness({ llmProviders: [hung], executors: { summary } });
    const modelRef = configureLlm(first);
    const taskId = createTaskOfKind(first, "regenerate_summary", { modelRef });
    first.scheduler.start();
    await waitFor(() => hung.calls.length === 3);
    expect(workUnitsOf(first, taskId).map((unit) => unit.status).sort()).toEqual(["pending", "pending", "running", "running", "running"]);
    const inCall = hung.calls.map((call) => call.request.system);
    await first.close();

    const resumed = new FakeLlmProvider();
    const second = harness({ file: first.file, llmProviders: [resumed], executors: { summary } });
    second.scheduler.start();
    await second.scheduler.whenIdle();
    const units = workUnitsOf(second, taskId);
    expect(units.map((unit) => unit.status).sort()).toEqual(["pending", "pending", "waiting_user_action", "waiting_user_action", "waiting_user_action"]);
    const parked = units.filter((unit) => unit.status === "waiting_user_action");
    expect(parked.map((unit) => unit.key).sort()).toEqual(inCall.map((system) => `summary:partial:${String(system).slice(-1)}`).sort());
    expect(parked.every((unit) => unit.error?.class === "llm_outcome_unknown")).toBe(true);
    expect(stageStatuses(second, taskId).summary).toBe("running");
    expect(taskOf(second, taskId).statusProjection).toBe("waiting");
    expect(resumed.calls).toHaveLength(0);

    for (const unit of parked) {
      second.tasks.confirmResend(LOCAL, taskId, unit.id);
    }
    await second.scheduler.whenIdle();
    expect(stageStatuses(second, taskId).summary).toBe("succeeded");
    expect(workUnitsOf(second, taskId).map((unit) => unit.status)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded", "succeeded"]);
    // The units in a call are re-sent once, after confirmation; the queued ones run once.
    expect(resumed.calls.map((call) => call.request.system).sort()).toEqual(["partial 1", "partial 2", "partial 3", "partial 4", "partial 5"]);
    for (const system of inCall) {
      expect([...hung.calls, ...resumed.calls].filter((call) => call.request.system === system)).toHaveLength(2);
    }
  });
});

describe("a re-run attempt reuses the earlier attempt's completed units", () => {
  it("takes over an intact checkpoint after retry-stage, without calling out again", async () => {
    const files = new LocalFileStore(tempDataDir("amber-reuse-"));
    let failAfterUnit = true;
    const stage = paidFileStage(files, {
      onRun: async () => undefined,
      afterUnit: () => {
        if (failAfterUnit) {
          failAfterUnit = false;
          throw amberError("internal");
        }
      },
    });
    const h = harness({ executors: { asr: stage.executor }, files });
    const asrModelRef = configureAsr(h);
    const taskId = createTaskOfKind(h, "retranscribe", { asrModelRef });
    h.scheduler.start();
    await h.scheduler.whenIdle();
    expect(taskOf(h, taskId).statusProjection).toBe("failed");
    const [first] = workUnitsOf(h, taskId);
    expect(first).toMatchObject({ status: "succeeded", billing: "asr" });

    h.tasks.retryStage(LOCAL, taskId, { stage: "asr" });
    await h.scheduler.whenIdle();
    expect(stage.calls()).toBe(1);
    const runs = stageRunsOf(h, taskId);
    expect(runs.map((run) => [run.attempt, run.status])).toEqual([[1, "failed"], [2, "succeeded"]]);
    const units = workUnitsOf(h, taskId);
    expect(units).toHaveLength(2);
    expect(units[1]).toMatchObject({ stageRunId: runs[1]?.id, status: "succeeded", outputRef: first?.outputRef, outputDigest: first?.outputDigest, billing: "asr" });
    expect(taskOf(h, taskId).statusProjection).toBe("succeeded");
  });

  it("runs again when the earlier output no longer matches its digest", async () => {
    const dir = tempDataDir("amber-reuse-tampered-");
    const files = new LocalFileStore(dir);
    let failAfterUnit = true;
    const stage = paidFileStage(files, {
      onRun: async () => undefined,
      afterUnit: () => {
        if (failAfterUnit) {
          failAfterUnit = false;
          throw amberError("internal");
        }
      },
    });
    const h = harness({ executors: { asr: stage.executor }, files });
    const asrModelRef = configureAsr(h);
    const taskId = createTaskOfKind(h, "retranscribe", { asrModelRef });
    h.scheduler.start();
    await h.scheduler.whenIdle();
    writeFileSync(join(dir, workUnitsOf(h, taskId)[0]?.outputRef as string), "tampered");

    h.tasks.retryStage(LOCAL, taskId, { stage: "asr" });
    await h.scheduler.whenIdle();
    expect(stage.calls()).toBe(2);
    expect(taskOf(h, taskId).statusProjection).toBe("succeeded");
  });

  it("copies an intact DB-only result into the new attempt and re-runs a tampered one", async () => {
    let calls = 0;
    let failAfterUnit = true;
    const summary: StageExecutor = {
      async run(context) {
        const value = await context.runUnit({ key: "summary:final", inputDigest: "in", billing: "llm", run: async () => ({ calls: ++calls }) });
        if (failAfterUnit) {
          failAfterUnit = false;
          throw amberError("internal");
        }
        return { resultJson: value };
      },
    };
    const h = harness({ executors: { summary } });
    const modelRef = configureLlm(h);
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef });
    h.scheduler.start();
    await h.scheduler.whenIdle();
    h.tasks.retryStage(LOCAL, taskId, { stage: "summary" });
    await h.scheduler.whenIdle();
    expect(calls).toBe(1);
    expect(JSON.parse(stageRunsOf(h, taskId)[1]?.resultJson ?? "null")).toEqual({ calls: 1 });
    expect(countRows(h.db, "work_unit_result")).toBe(2);
    expect(workUnitsOf(h, taskId)[1]).toMatchObject({ status: "succeeded", billing: "llm" });

    // A tampered earlier result is not taken over.
    const other = createTaskOfKind(h, "regenerate_summary", { modelRef });
    failAfterUnit = true;
    h.scheduler.kick();
    await h.scheduler.whenIdle();
    const [firstUnit] = workUnitsOf(h, other);
    h.db.prepare("UPDATE work_unit_result SET payload_json = '{\"calls\":99}' WHERE work_unit_id = ?").run(firstUnit?.id);
    h.tasks.retryStage(LOCAL, other, { stage: "summary" });
    await h.scheduler.whenIdle();
    expect(calls).toBe(3);
    expect(taskOf(h, other).statusProjection).toBe("succeeded");
  });
});

describe("retry backoff", () => {
  /** A scheduler over the harness's state whose in-process (stage-level) waits are recorded instead of slept. */
  function countingScheduler(h: Harness, executors: Record<string, StageExecutor>): { scheduler: Scheduler; waits: number[] } {
    const waits: number[] = [];
    const scheduler = new Scheduler({
      repository: h.repository,
      secrets: h.secrets,
      bus: h.bus,
      executors,
      settings: h.settings,
      disk: h.disk,
      gate: h.gate,
      mode: "local",
      logger: silentLogger,
      llm: h.llm,
      newId: h.newId,
      now: h.now,
      wakeAfter: (ms, wake) => {
        const timer = setTimeout(() => {
          waits.push(ms);
          wake();
        }, ms);
        return () => clearTimeout(timer);
      },
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    return { scheduler, waits };
  }

  const failingFirst = (errorClass: "output_mismatch" | "llm_failed"): { executor: StageExecutor; calls: () => number } => {
    let calls = 0;
    const executor: StageExecutor = {
      async run(context) {
        await context.runUnit({
          key: "proofread:chunk:0",
          inputDigest: "in",
          run: async () => {
            calls += 1;
            if (calls === 1) {
              throw amberError(errorClass, "first answer rejected");
            }
            return { ok: true };
          },
        });
        return {};
      },
    };
    return { executor, calls: () => calls };
  };

  it("re-asks a unit after output_mismatch at once, counting the retry", async () => {
    const h = harness({ executors: {} });
    const modelRef = configureLlm(h);
    const { executor, calls } = failingFirst("output_mismatch");
    const { scheduler, waits } = countingScheduler(h, { proofread: executor });
    const taskId = createTaskOfKind(h, "reproofread", { modelRef, baseRevisionId: "base" });
    scheduler.start();
    await scheduler.whenIdle();
    await scheduler.stop();
    expect(calls()).toBe(2);
    expect(waits).toEqual([]);
    expect(workUnitsOf(h, taskId)[0]).toMatchObject({ status: "succeeded", retryCount: 1 });
    expect(workUnitsOf(h, taskId)[0]?.retryNotBefore).toBeUndefined();
    expect(taskOf(h, taskId).statusProjection).toBe("succeeded");
  });

  it("persists the backoff of other policy retries on the unit and wakes the stage when it is due", async () => {
    const h = harness({ executors: {} });
    const modelRef = configureLlm(h);
    let calls = 0;
    const proofread: StageExecutor = {
      async run(context) {
        await context.runUnit({
          key: "proofread:chunk:0",
          inputDigest: "in",
          run: async () => {
            calls += 1;
            if (calls === 1) {
              throw amberError("llm_failed", "first answer rejected");
            }
            return { ok: true };
          },
        });
        return {};
      },
    };
    const { scheduler, waits } = countingScheduler(h, { proofread });
    const taskId = createTaskOfKind(h, "reproofread", { modelRef, baseRevisionId: "base" });
    const before = h.now();
    scheduler.start();
    await waitFor(() => workUnitsOf(h, taskId)[0]?.retryNotBefore !== undefined);
    const waiting = workUnitsOf(h, taskId)[0];
    expect(waiting).toMatchObject({ status: "pending", retryCount: 1, error: { class: "llm_failed" } });
    // RETRY_BASE_MS for the first retry.
    expect((waiting?.retryNotBefore as number) - before).toBeGreaterThanOrEqual(2000);
    await waitFor(() => !scheduler.isExecuting(taskId));
    expect(stageStatuses(h, taskId).proofread).toBe("running");
    expect(taskOf(h, taskId).statusProjection).toBe("queued");
    await scheduler.whenIdle();
    await scheduler.stop();
    expect(calls).toBe(2);
    // One wake, or one more when the timer fired a moment before the wall clock reached the time.
    expect(waits.length).toBeGreaterThanOrEqual(1);
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThan(1500);
    expect(workUnitsOf(h, taskId)[0]).toMatchObject({ status: "succeeded", retryCount: 1 });
    expect(taskOf(h, taskId).statusProjection).toBe("succeeded");
  }, 10_000);

  it("re-runs a stage failing with output_mismatch outside any unit without waiting", async () => {
    const h = harness({ executors: {} });
    const modelRef = configureLlm(h);
    let calls = 0;
    const chapter: StageExecutor = {
      async run() {
        calls += 1;
        if (calls === 1) {
          throw amberError("output_mismatch", "first answer rejected");
        }
        return {};
      },
    };
    const { scheduler, waits } = countingScheduler(h, { chapter });
    createTaskOfKind(h, "regenerate_chapters", { modelRef, baseRevisionId: "base", outputLanguage: "zh-CN" });
    scheduler.start();
    await scheduler.whenIdle();
    await scheduler.stop();
    expect(calls).toBe(2);
    expect(waits).toEqual([]);
  });
});

describe("waiting for a retry time", () => {
  it("gives the Task slot up while a unit waits, so a queued Task starts, and resumes once the time has come", async () => {
    const h = harness({ overrides: { concurrencyPipeline: 1 } });
    const modelRef = configureLlm(h);
    const started: string[] = [];
    let failures = 0;
    h.executors.summary = {
      async run(context) {
        started.push(context.task.id);
        await context.runUnit({
          key: "summary:final",
          inputDigest: "in",
          run: async () => {
            if (context.task.createdAt === 1 && failures === 0) {
              failures += 1;
              throw amberError("source_unreachable");
            }
            return "ok";
          },
        });
        return {};
      },
    };
    const first = createTaskOfKind(h, "regenerate_summary", { modelRef }, { createdAt: 1 });
    const second = createTaskOfKind(h, "regenerate_summary", { modelRef }, { createdAt: 2 });
    h.scheduler.start();
    await h.scheduler.whenIdle();
    // The first Task's wait freed the only slot: the second ran before the first resumed.
    expect(started).toEqual([first, second, first]);
    expect([first, second].map((id) => taskOf(h, id).statusProjection)).toEqual(["succeeded", "succeeded"]);
    expect(workUnitsOf(h, first)[0]).toMatchObject({ status: "succeeded", retryCount: 1 });
  });

  it("recovers from a requests-per-minute limit through lane cooldowns, every unit succeeding without exhausting its retries", async () => {
    const rpm = 3;
    const sends: number[] = [];
    let limited = 0;
    let h: Harness | undefined;
    const upstream = new FakeLlmProvider();
    upstream.script(
      ...Array.from({ length: 200 }, () => () =>
        (async function* () {
          const now = (h as Harness).now();
          const recent = sends.filter((at) => at > now - 60_000);
          if (recent.length >= rpm) {
            limited += 1;
            throw amberError("llm_rate_limited", "requests per minute");
          }
          sends.push(now);
          yield* reply("ok");
        })(),
      ),
    );
    h = harness({ overrides: { concurrencyPipeline: 2 }, llmProviders: [upstream] });
    const modelRef = configureLlm(h);
    h.executors.summary = {
      async run(context) {
        const settled = await Promise.allSettled(
          [1, 2, 3, 4, 5, 6].map((n) =>
            context.runUnit({
              key: `summary:partial:${n}`,
              inputDigest: `partial-${n}`,
              billing: "llm",
              run: async (_signal, unit) =>
                (
                  await context.llm.complete(
                    { modelRef, system: `partial ${n}`, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
                    { feature: "summary", workUnitId: unit.id },
                  )
                ).text,
            }),
          ),
        );
        const failure = stageUnitFailure(settled);
        if (failure !== undefined) {
          throw failure;
        }
        return {};
      },
    };
    const taskId = createTaskOfKind(h, "regenerate_summary", { modelRef });
    const startedAt = h.now();
    h.scheduler.start();
    await h.scheduler.whenIdle();
    expect(stageStatuses(h, taskId).summary).toBe("succeeded");
    expect(sends).toHaveLength(6);
    // Six sends at three a minute need more than a minute of (simulated) waiting.
    expect(h.now() - startedAt).toBeGreaterThan(60_000);
    const units = workUnitsOf(h, taskId);
    expect(units.every((unit) => unit.status === "succeeded" && unit.retryCount <= 3)).toBe(true);
    // Each rejected send was a unit retry; calls turned away during a cooldown were not.
    expect(units.reduce((sum, unit) => sum + unit.retryCount, 0)).toBe(limited);
  }, 20_000);
});

describe("readyStages", () => {
  const run = (stage: "source" | "subtitle", status: string, dependencies: Array<"source" | "subtitle"> = []) => ({
    id: stage, taskId: "t", stage, attempt: 1, status, progress: 0, dependencies,
  }) as never;

  it("offers pending stages only once their dependencies are done, plus interrupted and orphaned running ones", () => {
    expect(readyStages({ runs: [run("source", "running"), run("subtitle", "pending", ["source"])], units: [] }, new Set(["source"]), 0)).toEqual([]);
    expect(readyStages({ runs: [run("source", "succeeded"), run("subtitle", "pending", ["source"])], units: [] }, new Set(), 0).map((r) => r.stage)).toEqual(["subtitle"]);
    expect(readyStages({ runs: [run("source", "interrupted")], units: [] }, new Set(), 0).map((r) => r.stage)).toEqual(["source"]);
    expect(readyStages({ runs: [run("source", "running")], units: [{ stageRunId: "source", status: "waiting_user_action" } as never] }, new Set(), 0)).toEqual([]);
  });

  it("holds a started stage back until the latest retry time of its waiting units, also after a restart", () => {
    const waiting = [
      { stageRunId: "source", status: "pending", retryNotBefore: 5000 },
      { stageRunId: "source", status: "pending", retryNotBefore: 7000 },
      { stageRunId: "source", status: "succeeded" },
    ] as never[];
    for (const status of ["running", "interrupted"]) {
      expect(readyStages({ runs: [run("source", status)], units: waiting }, new Set(), 6999)).toEqual([]);
      expect(readyStages({ runs: [run("source", status)], units: waiting }, new Set(), 7000).map((r) => r.stage)).toEqual(["source"]);
    }
    expect(nextRetryTime({ runs: [run("source", "running")], units: waiting }, 1000)).toBe(7000);
    expect(nextRetryTime({ runs: [run("source", "running")], units: waiting }, 7000)).toBeUndefined();
    // A unit in a call means the stage is executing, not waiting.
    const executing = [...waiting, { stageRunId: "source", status: "running" }] as never[];
    expect(nextRetryTime({ runs: [run("source", "running")], units: executing }, 1000)).toBeUndefined();
  });
});

describe("settleTasks", () => {
  it("waits for an aborted execution to unwind and treats idle Tasks as settled", async () => {
    let finishedUnwinding = false;
    const stuck: StageExecutor = {
      async run(context) {
        await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
        // Process trees take a moment to die after the abort.
        await new Promise((resolve) => setTimeout(resolve, 30));
        finishedUnwinding = true;
        throw context.signal.reason;
      },
    };
    const h = harness({ executors: { cache_media: stuck } });
    const taskId = createTaskOfKind(h, "cache_media", {});
    h.scheduler.start();
    await waitFor(() => h.scheduler.isExecuting(taskId));

    await h.scheduler.settleTasks(["unknown-task"]);
    // Cancellation aborts the execution and commits `cancelled`, so no new execution starts.
    h.tasks.cancel(LOCAL, taskId);
    expect(h.scheduler.isExecuting(taskId)).toBe(true);
    await h.scheduler.settleTasks([taskId]);
    expect(finishedUnwinding).toBe(true);
    expect(h.scheduler.isExecuting(taskId)).toBe(false);
  });
});

describe("unit-level waits and the start of a paid call", () => {
  /** A logger that keeps its error records. */
  function recordingLogger(): { logger: typeof silentLogger; errors: Array<{ message: string; fields: unknown }> } {
    const errors: Array<{ message: string; fields: unknown }> = [];
    return {
      errors,
      logger: { ...silentLogger, error: (message: string, fields?: unknown) => errors.push({ message, fields }) } as typeof silentLogger,
    };
  }

  function unitOf(h: Harness, taskId: string) {
    return workUnitsOf(h, taskId).find((unit) => unit.key === "asr:job");
  }

  it("UnitDeferred waits as pending until its time without spending a retry, then runs again", async () => {
    const h = harness();
    const asrModelRef = configureAsr(h);
    const seen: Array<{ attempt: number; retryCount: number }> = [];
    h.executors.asr = {
      async run(context) {
        await context.runUnit({
          key: "asr:job",
          inputDigest: "in",
          run: async (_signal, unit) => {
            seen.push({ attempt: unit.attempt, retryCount: unit.retryCount });
            if (seen.length === 1) {
              throw new UnitDeferred(Date.now() + 60);
            }
            return { done: true };
          },
        });
        return {};
      },
    };
    // Recorded from the events, so a busy machine cannot run past the short wait unseen.
    const waits: unknown[] = [];
    h.bus.subscribe(({ event }) => {
      if (event.type === "workunit.updated" && event.workUnit.key === "asr:job" && event.workUnit.retryNotBefore !== undefined) {
        waits.push(event.workUnit);
      }
    });
    const taskId = createTaskOfKind(h, "retranscribe", { asrModelRef });
    h.scheduler.start();
    await waitFor(() => stageStatuses(h, taskId).asr === "succeeded");
    expect(waits).toEqual([expect.objectContaining({ status: "pending", retryCount: 0 })]);
    expect(seen).toEqual([
      { attempt: 1, retryCount: 0 },
      { attempt: 2, retryCount: 0 },
    ]);
  });

  it("resetRetries clears the retries a transient failure spent and its error", async () => {
    const h = harness();
    const asrModelRef = configureAsr(h);
    const seen: number[] = [];
    h.executors.asr = {
      async run(context) {
        await context.runUnit({
          key: "asr:job",
          inputDigest: "in",
          run: async (_signal, unit) => {
            seen.push(unit.retryCount);
            if (seen.length === 1) {
              throw amberError("asr_failed", "throttled", { code: "asr_failed.rate_limited", details: { retryAfterMs: 10 } });
            }
            if (seen.length === 2) {
              throw new UnitDeferred(Date.now() + 10, { resetRetries: true });
            }
            return {};
          },
        });
        return {};
      },
    };
    const taskId = createTaskOfKind(h, "retranscribe", { asrModelRef });
    h.scheduler.start();
    await waitFor(() => stageStatuses(h, taskId).asr === "succeeded");
    expect(seen).toEqual([0, 1, 0]);
    expect(unitOf(h, taskId)?.error).toBeUndefined();
  });

  it("an explicit-start paid unit stays pending until it marks its call, once", async () => {
    const h = harness();
    const asrModelRef = configureAsr(h);
    const statuses: string[] = [];
    let taskId = "";
    h.executors.asr = {
      async run(context) {
        await context.runUnit({
          key: "asr:job",
          inputDigest: "in",
          billing: "asr",
          paidCallStart: "explicit",
          run: async (_signal, unit) => {
            statuses.push(unitOf(h, taskId)?.status ?? "none");
            unit.markPaidCallStart();
            statuses.push(unitOf(h, taskId)?.status ?? "none");
            unit.markPaidCallStart();
            return {};
          },
        });
        return {};
      },
    };
    taskId = createTaskOfKind(h, "retranscribe", { asrModelRef });
    h.scheduler.start();
    await waitFor(() => stageStatuses(h, taskId).asr === "succeeded");
    expect(statuses).toEqual(["pending", "running"]);
  });

  it("logs an explicit-start paid unit that returned without marking its call", async () => {
    const { logger, errors } = recordingLogger();
    const h = harness({ logger });
    const asrModelRef = configureAsr(h);
    h.executors.asr = {
      async run(context) {
        await context.runUnit({ key: "asr:job", inputDigest: "in", billing: "asr", paidCallStart: "explicit", run: async () => ({}) });
        return {};
      },
    };
    const taskId = createTaskOfKind(h, "retranscribe", { asrModelRef });
    h.scheduler.start();
    await waitFor(() => stageStatuses(h, taskId).asr === "succeeded");
    expect(errors).toEqual([{ message: "unit_paid_call_unmarked", fields: { taskId, key: "asr:job" } }]);
  });

  it("crash recovery re-runs an explicit-start unit that had not marked its call, and parks one that had", async () => {
    for (const marked of [false, true]) {
      const started = gate();
      let crash = true;
      let runs = 0;
      const executor: StageExecutor = {
        async run(context) {
          await context.runUnit({
            key: "asr:job",
            inputDigest: "in",
            billing: "asr",
            paidCallStart: "explicit",
            run: async (signal, unit) => {
              runs += 1;
              if (crash) {
                if (marked) {
                  unit.markPaidCallStart();
                }
                started.open();
                await hangUntilAborted(signal);
              }
              unit.markPaidCallStart();
              return {};
            },
          });
          return {};
        },
      };
      const first = harness({ executors: { asr: executor } });
      const asrModelRef = configureAsr(first);
      const taskId = createTaskOfKind(first, "retranscribe", { asrModelRef });
      first.scheduler.start();
      await started.promise;
      await first.close();
      crash = false;

      const second = harness({ file: first.file, executors: { asr: executor } });
      second.scheduler.start();
      await second.scheduler.whenIdle();
      if (marked) {
        expect(unitOf(second, taskId)).toMatchObject({ status: "waiting_user_action", error: { class: "asr_timeout" } });
        expect(runs).toBe(1);
      } else {
        expect(unitOf(second, taskId)?.status).toBe("succeeded");
        expect(runs).toBe(2);
      }
    }
  });
});
