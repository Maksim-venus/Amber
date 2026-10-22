import { describe, expect, it } from "vitest";
import type { StageRun, WorkUnit } from "../../../src/server/domain/task.ts";
import { latestAttempts, projectStatus, taskRetryNotBefore, taskWait } from "../../../src/server/pipeline/projection.ts";

const run = (id: string, stage: StageRun["stage"], status: StageRun["status"], attempt = 1): StageRun => ({
  id, taskId: "t", stage, attempt, status, progress: 0, dependencies: [],
});
const unit = (stageRunId: string, status: WorkUnit["status"], retryNotBefore?: number): WorkUnit => ({
  id: `${stageRunId}-${status}-${retryNotBefore ?? ""}`,
  stageRunId,
  key: "k",
  status,
  attempt: 1,
  retryCount: retryNotBefore === undefined ? 0 : 1,
  inputDigest: "d",
  ...(retryNotBefore === undefined ? {} : { retryNotBefore }),
});

describe("projectStatus (first matching rule)", () => {
  it("1. running when a unit runs or a running stage has no parked unit", () => {
    expect(projectStatus([run("a", "asr", "running")], [])).toBe("running");
    expect(projectStatus([run("a", "asr", "running"), run("b", "summary", "waiting_configuration")], [])).toBe("running");
    expect(projectStatus([run("a", "asr", "succeeded"), run("b", "summary", "running")], [unit("b", "running"), unit("b", "waiting_user_action")])).toBe(
      "running",
    );
  });

  it("2. waiting for a parked unit or missing configuration (outcome_unknown keeps its stage running)", () => {
    expect(projectStatus([run("a", "summary", "running")], [unit("a", "waiting_user_action")])).toBe("waiting");
    expect(projectStatus([run("a", "summary", "waiting_configuration"), run("b", "chapter", "pending")], [])).toBe("waiting");
    expect(projectStatus([run("a", "summary", "interrupted")], [unit("a", "waiting_user_action")])).toBe("waiting");
  });

  it("3. queued while anything is still schedulable", () => {
    expect(projectStatus([run("a", "source", "succeeded"), run("b", "subtitle", "pending")], [])).toBe("queued");
    expect(projectStatus([run("a", "source", "interrupted")], [])).toBe("queued");
  });

  it("4. terminal: cancelled over failed over succeeded; only the latest attempt counts", () => {
    expect(projectStatus([run("a", "source", "cancelled"), run("b", "subtitle", "failed")], [])).toBe("cancelled");
    expect(projectStatus([run("a", "source", "failed"), run("b", "subtitle", "skipped")], [])).toBe("failed");
    expect(projectStatus([run("a", "source", "failed"), run("a2", "source", "succeeded", 2), run("b", "subtitle", "skipped")], [])).toBe("succeeded");
    expect(latestAttempts([run("a", "source", "failed"), run("a2", "source", "succeeded", 2)]).map((r) => r.id)).toEqual(["a2"]);
  });
});

describe("a stage that only waits for its units' retry times", () => {
  it("is queued, not running, and shows the latest retry time; a running or parked unit outweighs it", () => {
    const waiting = [unit("a", "succeeded"), unit("a", "pending", 5000), unit("a", "pending", 9000)];
    expect(projectStatus([run("a", "proofread", "running")], waiting)).toBe("queued");
    expect(taskRetryNotBefore([run("a", "proofread", "running")], waiting)).toBe(9000);
    // After a restart crash recovery marks the stage interrupted; it still waits.
    expect(projectStatus([run("a", "proofread", "interrupted")], waiting)).toBe("queued");
    expect(taskRetryNotBefore([run("a", "proofread", "interrupted")], waiting)).toBe(9000);
    expect(projectStatus([run("a", "proofread", "running")], [...waiting, unit("a", "running")])).toBe("running");
    expect(taskRetryNotBefore([run("a", "proofread", "running")], [...waiting, unit("a", "running")])).toBeUndefined();
    expect(projectStatus([run("a", "proofread", "running")], [...waiting, unit("a", "waiting_user_action")])).toBe("waiting");
    // Another stage still executing keeps the Task running.
    expect(projectStatus([run("a", "proofread", "running"), run("b", "chapter", "running")], waiting)).toBe("running");
  });
});

describe("taskWait", () => {
  it("names the step of the unit that sets the latest wait, when that unit names one", () => {
    const awaiting: WorkUnit = { ...unit("a", "pending", 9000), key: "asr:await" };
    const submitted: WorkUnit = { ...unit("a", "succeeded"), id: "submitted", key: "asr:submit" };
    expect(taskWait([run("a", "asr", "running")], [submitted, awaiting])).toEqual({ retryNotBefore: 9000, waitingStep: "awaitResult" });
    // A proofreading range is no named step: only the time is shown.
    expect(taskWait([run("a", "proofread", "running")], [{ ...unit("a", "pending", 5000), key: "proofread:range:1-150" }])).toEqual({ retryNotBefore: 5000 });
    expect(taskWait([run("a", "asr", "succeeded")], [submitted])).toEqual({});
  });
});
