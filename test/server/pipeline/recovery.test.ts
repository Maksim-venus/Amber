import { afterEach, describe, expect, it } from "vitest";
import { recoverInterrupted } from "../../../src/server/pipeline/recovery.ts";
import { createHarness, createTaskOfKind, stageRunsOf, taskOf, workUnitsOf, type Harness } from "../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

describe("recoverInterrupted", () => {
  it("turns running stages and units into interrupted, leaves parked units alone and re-projects", () => {
    const h = createHarness();
    open.push(h);
    const taskId = createTaskOfKind(h, "cache_media", {});
    const [run] = stageRunsOf(h, taskId);
    h.db.prepare("UPDATE stage_run SET status = 'running'").run();
    h.db.prepare("UPDATE task SET status_projection = 'running'").run();
    const insertUnit = h.db.prepare("INSERT INTO work_unit (id, stage_run_id, unit_key, status, attempt, input_digest) VALUES (?, ?, ?, ?, 1, 'd')");
    insertUnit.run("w1", run?.id, "a", "running");
    insertUnit.run("w2", run?.id, "b", "waiting_user_action");
    insertUnit.run("w3", run?.id, "c", "succeeded");

    expect(recoverInterrupted(h.repository, h.bus, 5)).toBe(2);
    expect(stageRunsOf(h, taskId)[0]?.status).toBe("interrupted");
    expect(workUnitsOf(h, taskId).map((unit) => unit.status)).toEqual(["interrupted", "waiting_user_action", "succeeded"]);
    expect(taskOf(h, taskId).statusProjection).toBe("waiting");
  });

  it("parks running paid units for the user and keeps their stage running", () => {
    const h = createHarness();
    open.push(h);
    const taskId = createTaskOfKind(h, "retranscribe", {});
    const [run] = stageRunsOf(h, taskId);
    h.db.prepare("UPDATE stage_run SET status = 'running'").run();
    h.db.prepare("UPDATE task SET status_projection = 'running'").run();
    const insertUnit = h.db.prepare("INSERT INTO work_unit (id, stage_run_id, unit_key, status, attempt, input_digest, billing) VALUES (?, ?, ?, 'running', 1, 'd', ?)");
    insertUnit.run("w1", run?.id, "media:extract_audio", "none");
    insertUnit.run("w2", run?.id, "asr:submit", "asr");

    expect(recoverInterrupted(h.repository, h.bus, 5)).toBe(2);
    expect(stageRunsOf(h, taskId)[0]?.status).toBe("running");
    const units = workUnitsOf(h, taskId);
    expect(units[0]).toMatchObject({ status: "interrupted" });
    expect(units[1]).toMatchObject({ status: "waiting_user_action", billing: "asr", error: { class: "asr_timeout", retryDisposition: "outcome_unknown" } });
    expect(taskOf(h, taskId).statusProjection).toBe("waiting");
  });

  it("gives a parked LLM unit the LLM unknown-outcome error", () => {
    const h = createHarness();
    open.push(h);
    const taskId = createTaskOfKind(h, "cache_media", {});
    const [run] = stageRunsOf(h, taskId);
    h.db.prepare("UPDATE stage_run SET status = 'running'").run();
    h.db.prepare("INSERT INTO work_unit (id, stage_run_id, unit_key, status, attempt, input_digest, billing) VALUES ('w', ?, 'k', 'running', 1, 'd', 'llm')").run(run?.id);
    recoverInterrupted(h.repository, h.bus, 5);
    expect(workUnitsOf(h, taskId)[0]).toMatchObject({ status: "waiting_user_action", error: { class: "llm_outcome_unknown" } });
  });

  it("leaves LLM units still queued for their slot pending: they sent nothing", () => {
    const h = createHarness();
    open.push(h);
    const taskId = createTaskOfKind(h, "cache_media", {});
    const [run] = stageRunsOf(h, taskId);
    h.db.prepare("UPDATE stage_run SET status = 'running'").run();
    const insertUnit = h.db.prepare("INSERT INTO work_unit (id, stage_run_id, unit_key, status, attempt, input_digest, billing) VALUES (?, ?, ?, ?, 1, 'd', 'llm')");
    insertUnit.run("w1", run?.id, "a", "running");
    insertUnit.run("w2", run?.id, "b", "pending");
    insertUnit.run("w3", run?.id, "c", "pending");

    expect(recoverInterrupted(h.repository, h.bus, 5)).toBe(1);
    expect(workUnitsOf(h, taskId).map((unit) => unit.status)).toEqual(["waiting_user_action", "pending", "pending"]);
    expect(stageRunsOf(h, taskId)[0]?.status).toBe("running");
    expect(taskOf(h, taskId).statusProjection).toBe("waiting");
  });

  it("keeps a unit waiting for its retry time pending with its time and count: it is not in a call", () => {
    const h = createHarness();
    open.push(h);
    const taskId = createTaskOfKind(h, "cache_media", {});
    const [run] = stageRunsOf(h, taskId);
    h.db.prepare("UPDATE stage_run SET status = 'running'").run();
    h.db
      .prepare("INSERT INTO work_unit (id, stage_run_id, unit_key, status, attempt, input_digest, billing, retry_count, retry_not_before) VALUES ('w', ?, 'k', 'pending', 1, 'd', 'llm', 2, 9000)")
      .run(run?.id);
    recoverInterrupted(h.repository, h.bus, 5);
    expect(workUnitsOf(h, taskId)[0]).toMatchObject({ status: "pending", retryCount: 2, retryNotBefore: 9000 });
    expect(workUnitsOf(h, taskId)[0]?.error).toBeUndefined();
    // Its stage is re-queued like any interrupted one, and shows the wait.
    expect(stageRunsOf(h, taskId)[0]?.status).toBe("interrupted");
    expect(taskOf(h, taskId).statusProjection).toBe("queued");
  });
});
