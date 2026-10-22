import { afterEach, describe, expect, it } from "vitest";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import type { ModelRef } from "../../../src/server/domain/model-ref.ts";
import { latestAttempts } from "../../../src/server/pipeline/projection.ts";
import { transact } from "../../../src/server/pipeline/publish.ts";
import type { StageRun } from "../../../src/server/domain/task.ts";
import { loadTaskState, propagateStageInput, stageEngine, type TaskState } from "../../../src/server/pipeline/task-state.ts";
import { STAGE_STATUSES, type StageStatus } from "../../../src/shared/enums.ts";
import { configureAsr, createHarness, createTaskOfKind, LOCAL, stageInputsOf, stageRunsOf, type Harness } from "../../fixtures/pipeline/harness.ts";

const modelRef: ModelRef = { providerProfileId: "p", modelId: "m" };
const other: ModelRef = { providerProfileId: "p", modelId: "n" };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

/** A local process_content task (media → asr → proofread → chapter → summary) with statuses set directly. */
function taskWith(h: Harness, statuses: Partial<Record<string, StageStatus>>, inputs: Partial<Record<string, string>> = {}): string {
  const taskId = createTaskOfKind(h, "process_content", { autoProofread: true });
  for (const run of stageRunsOf(h, taskId)) {
    const status = statuses[run.stage];
    if (status !== undefined) h.db.prepare("UPDATE stage_run SET status = ? WHERE id = ?").run(status, run.id);
    const input = inputs[run.stage];
    if (input !== undefined) h.db.prepare("UPDATE stage_run SET input_json = ? WHERE id = ?").run(input, run.id);
  }
  return taskId;
}

function propagate(h: Harness, taskId: string, excludeStage: string): string[] {
  return transact(h.repository, h.bus, (scope, outbox) => {
    const state = loadTaskState(scope, LOCAL.userId, taskId) as TaskState;
    const exclude = latestAttempts(state.runs).find((run) => run.stage === excludeStage) as { id: string };
    return propagateStageInput(scope, outbox, state, { modelRef }, exclude);
  });
}

describe("propagateStageInput", () => {
  it("writes only pending LLM stages without input, skipping the excluded stage and existing choices", () => {
    const h = createHarness();
    open.push(h);
    const taskId = taskWith(h, { media: "succeeded", asr: "skipped", proofread: "waiting_configuration" }, { summary: JSON.stringify({ modelRef: other }) });
    expect(propagate(h, taskId, "proofread")).toEqual(["chapter"]);
    expect(stageInputsOf(h, taskId)).toEqual({
      media: undefined, asr: undefined, proofread: undefined, chapter: JSON.stringify({ modelRef }), summary: JSON.stringify({ modelRef: other }),
    });
  });

  it("leaves every non-pending status and every non-LLM stage alone", () => {
    const h = createHarness();
    open.push(h);
    for (const status of STAGE_STATUSES.filter((candidate) => candidate !== "pending")) {
      const taskId = taskWith(h, { proofread: "waiting_configuration", chapter: status, summary: status });
      expect(propagate(h, taskId, "proofread"), status).toEqual([]);
      expect(stageInputsOf(h, taskId), status).toEqual({ media: undefined, asr: undefined, proofread: undefined, chapter: undefined, summary: undefined });
    }
    const taskId = taskWith(h, { proofread: "waiting_configuration", chapter: "succeeded", summary: "succeeded" });
    // media and asr are pending but need no LLM.
    expect(propagate(h, taskId, "proofread")).toEqual([]);
  });

  it("reports an input that exists without a model instead of overwriting it", () => {
    const h = createHarness();
    open.push(h);
    const taskId = taskWith(h, { proofread: "waiting_configuration" }, { chapter: "{}" });
    let code: string | undefined;
    try {
      propagate(h, taskId, "proofread");
    } catch (error) {
      code = isAmberError(error) ? error.appError.code : String(error);
    }
    expect(code).toBe("internal");
    expect(stageInputsOf(h, taskId)).toMatchObject({ chapter: "{}", summary: undefined });
  });
});

describe("stageEngine of an ASR stage", () => {
  it("names the bound model and the profile's provider, falls back to the Task's usage once it is gone, and is absent unbound", () => {
    const h = createHarness();
    open.push(h);
    const asrModelRef = configureAsr(h, LOCAL.userId, { models: ["scribe_v2", "scribe_v2_medical"] });
    const { asrProfileId } = asrModelRef;
    const medical = { asrProfileId, modelId: "scribe_v2_medical" };
    const engineOf = (taskId: string) =>
      h.repository.withTransaction((scope) => {
        const run = scope.stageRuns.listByTask(LOCAL.userId, taskId).find((candidate) => candidate.stage === "asr") as StageRun;
        return stageEngine(scope, LOCAL.userId, run);
      });
    const bound = createTaskOfKind(h, "retranscribe", { asrModelRef: medical });
    expect(engineOf(bound)).toEqual({ kind: "asr", asrModelRef: medical, provider: "elevenlabs" });
    expect(engineOf(createTaskOfKind(h, "retranscribe", {}))).toBeUndefined();

    h.repository.withTransaction((scope) => {
      scope.asrUsage.insert({ id: h.newId(), userId: LOCAL.userId, asrProfileId, provider: "elevenlabs", model: "scribe_v2_medical", feature: "transcribe", outcome: "succeeded", audioMs: 1000, taskId: bound, createdAt: 1 });
      scope.asrProfiles.delete(LOCAL.userId, asrProfileId);
    });
    // The model stays in the binding; the provider comes from the usage once the profile is gone.
    expect(engineOf(bound)).toEqual({ kind: "asr", asrModelRef: medical, provider: "elevenlabs" });
    const forgotten = createTaskOfKind(h, "retranscribe", { asrModelRef });
    expect(engineOf(forgotten)).toEqual({ kind: "asr", asrModelRef });
  });
});
