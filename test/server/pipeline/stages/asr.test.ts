import { writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RetranscribeService } from "../../../../src/server/application/retranscribe.ts";
import { LocalFileStore } from "../../../../src/server/adapters/file-store/local-file-store.ts";
import { amberError } from "../../../../src/server/domain/errors.ts";
import type { MediaAsset } from "../../../../src/server/domain/media-asset.ts";
import type { AsrModelRef } from "../../../../src/server/domain/model-ref.ts";
import type { TranscriptRevision } from "../../../../src/server/domain/transcript.ts";
import { latestAttempts, taskWait } from "../../../../src/server/pipeline/projection.ts";
import { asrPollDelayMs, AsrStageExecutor, JOB_ENDED_CODES } from "../../../../src/server/pipeline/stages/asr.ts";
import { ASR_JOB_MAX_WAIT_HOURS, ASR_POLL_INTERVAL_MAX_MS, ASR_POLL_INTERVAL_MS, RETRY_MAX } from "../../../../src/shared/defaults.ts";
import type { LocalMediaIngest } from "../../../../src/server/ports/local-media-ingest.ts";
import { isUlid } from "../../../../src/shared/ids.ts";
import { fakeAsrResult, FakeAsrFactory } from "../../../fixtures/asr/fake-asr.ts";
import { mediaFixtures } from "../../../fixtures/media/index.ts";
import {
  configureAsr,
  configureLlm,
  countingExecutor,
  createHarness,
  LOCAL,
  stageRunsOf,
  stageStatuses,
  taskOf,
  waitFor,
  workUnitsOf,
  type Harness,
} from "../../../fixtures/pipeline/harness.ts";
import { createMediaStack, type MediaStack } from "../../../fixtures/pipeline/media-stack.ts";
import { insertRow, tempDataDir } from "../../../tools/sqlite.ts";

const open: MediaStack[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const stack of open.splice(0)) await stack.close();
  for (const h of harnesses.splice(0)) await h.close();
});

/** Every progress value the `asr` stage published, in order. */
function asrProgressEvents(h: Harness): number[] {
  const values: number[] = [];
  h.bus.subscribe(({ event }) => {
    if (event.type === "stage.updated" && event.stageRun.stage === "asr") {
      values.push(event.stageRun.progress);
    }
  });
  return values;
}

/** Extraction without ffmpeg that reports half-way and done, as the real adapter does with a duration hint. */
function reportingIngest(): LocalMediaIngest {
  return {
    probe: async () => Promise.reject(new Error("not used")),
    transcodeAudio: async () => Promise.reject(new Error("not used")),
    async extractAudio(input, output, _signal, options) {
      const bytes = Buffer.concat([Buffer.from("flac:"), await readFile(input.path)]);
      options?.onProgress?.(0.5);
      await writeFile(output.path, bytes);
      options?.onProgress?.(1);
      return { sizeBytes: bytes.length, durationMs: 3000 };
    },
    clipAudio: async () => Promise.reject(new Error("not used")),
  };
}

function setup(): { stack: MediaStack; fake: FakeAsrFactory } {
  const fake = new FakeAsrFactory();
  const stack = createMediaStack();
  open.push(stack);
  stack.h.executors.asr = new AsrStageExecutor({
    repository: stack.h.repository,
    files: stack.files,
    ingest: stack.ingest,
    asr: (provider) => (provider === fake.descriptor.provider ? fake : undefined),
    newId: stack.h.newId,
  });
  configureAsr(stack.h);
  return { stack, fake };
}

/**
 * Imports the 3 s fixture without auto-proofreading, choosing the given ASR model, else the
 * user's default as the new-Task page preselects it; returns the Task and Content ids.
 */
async function importFixture(stack: MediaStack, options: { subtitle?: string; asrModelRef?: AsrModelRef } = {}): Promise<{ taskId: string; contentId: string }> {
  const { withAudio } = mediaFixtures();
  let initialSubtitle: { path: string; grant: ReturnType<MediaStack["grant"]>; language: string } | undefined;
  if (options.subtitle !== undefined) {
    const path = join(tempDataDir("amber-sub-"), "sub.srt");
    writeFileSync(path, options.subtitle);
    initialSubtitle = { path, grant: stack.grant(path, "local_file"), language: "zh-CN" };
  }
  const asrModelRef = options.asrModelRef ?? stack.h.repository.withTransaction((scope) => scope.userSettings.get(LOCAL.userId)?.defaultAsrModelRef);
  const created = await stack.localImport.importLocalFile(LOCAL, {
    path: withAudio.path,
    grant: stack.grant(withAudio.path),
    settings: { autoProofread: false, ...(asrModelRef === undefined ? {} : { asrModelRef }) },
    allowDuplicate: true,
    ...(initialSubtitle === undefined ? {} : { initialSubtitle }),
  });
  return { taskId: created.body.taskIds[0] as string, contentId: created.body.contentIds[0] as string };
}

async function asrSettled(stack: MediaStack, taskId: string): Promise<string> {
  await waitFor(() => ["succeeded", "failed", "skipped"].includes(stageStatuses(stack.h, taskId)["asr"] ?? "") || taskOf(stack.h, taskId).statusProjection === "waiting" && workUnitsOf(stack.h, taskId).some((unit) => unit.status === "waiting_user_action"));
  return stageStatuses(stack.h, taskId)["asr"] as string;
}

function revisionsOf(stack: MediaStack, contentId: string): TranscriptRevision[] {
  return stack.h.repository.withTransaction((scope) => scope.transcripts.listRevisions(LOCAL.userId, contentId));
}

function contentOf(stack: MediaStack, contentId: string) {
  return stack.h.repository.withTransaction((scope) => scope.contents.get(LOCAL.userId, contentId));
}

function usageOf(stack: MediaStack, taskId: string) {
  return stack.h.repository.withTransaction((scope) => scope.asrUsage.list(LOCAL.userId, { taskId }));
}

function asrResultJson(stack: MediaStack, taskId: string): Record<string, unknown> {
  const run = stageRunsOf(stack.h, taskId).filter((candidate) => candidate.stage === "asr").at(-1);
  return JSON.parse(run?.resultJson ?? "{}") as Record<string, unknown>;
}

const SRT = "1\n00:00:00,000 --> 00:00:01,500\n用户导入的字幕\n";

describe("asr stage", () => {
  it("publishes an immutable exact_words revision with ULID segments, words by midpoint, and records usage", async () => {
    const { stack, fake } = setup();
    const { taskId, contentId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");

    const [revision] = revisionsOf(stack, contentId);
    expect(revision).toMatchObject({ kind: "asr", timingFidelity: "exact_words", language: "zh", segmentCount: 2 });
    expect(revision?.generation).toMatchObject({ kind: "asr", modelId: "scribe_v2" });
    expect(fake.calls.map((call) => call.modelId)).toEqual(["scribe_v2"]);
    const segments = stack.h.repository.withTransaction((scope) => scope.transcripts.listSegments(LOCAL.userId, revision?.id as string));
    expect(segments.map((segment) => segment.text)).toEqual(["欢迎来到生成式软件工程。", "今天讲提示词。"]);
    expect(new Set(segments.map((segment) => segment.id)).size).toBe(2);
    for (const segment of segments) {
      expect(isUlid(segment.id)).toBe(true);
      expect(segment.startMs).toBeLessThan(segment.endMs);
      expect(segment.sourceSegmentIds).toEqual([]);
    }
    expect(segments.map((segment) => segment.words?.map((word) => word.text))).toEqual([
      ["欢迎", "来到", "生成式软件工程。"],
      ["今天", "讲", "提示词。"],
    ]);
    // Committed revisions cannot be rewritten in place.
    expect(() => stack.h.db.prepare("UPDATE transcript_segment SET text = 'x' WHERE id = ?").run(segments[0]?.id)).toThrow(/immutable/);
    expect(() =>
      stack.h.repository.withTransaction((scope) => scope.transcripts.insertRevision(LOCAL.userId, revision as TranscriptRevision, segments)),
    ).toThrow();

    const content = contentOf(stack, contentId);
    expect(content?.primaryTranscriptRevisionId).toBe(revision?.id);
    expect(content?.rawLanguage).toBe("zh");
    expect(asrResultJson(stack, taskId)).toMatchObject({ revisionId: revision?.id, reasons: [] });

    const usage = usageOf(stack, taskId);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ outcome: "succeeded", provider: "elevenlabs", model: "scribe_v2", feature: "transcribe", contentId, taskId });
    expect(Math.abs((usage[0]?.audioMs ?? 0) - 3000)).toBeLessThanOrEqual(100);

    const unit = workUnitsOf(stack.h, taskId).find((candidate) => candidate.key === "asr:submit");
    expect(unit).toMatchObject({ status: "succeeded", billing: "asr", outputRef: `tmp/tasks/${taskId}/asr-${unit?.id}.json` });
    expect(fake.calls).toHaveLength(1);
    expect((fake.calls[0]?.input.audio as MediaAsset | undefined)?.kind).toBe("extracted_audio");
  });

  it("an imported primary is not displaced; a later retranscription replaces an asr primary", async () => {
    const { stack, fake } = setup();
    const imported = await importFixture(stack, { subtitle: SRT });
    stack.h.scheduler.start();
    // The user's own subtitle makes ASR unnecessary in process_content.
    expect(await asrSettled(stack, imported.taskId)).toBe("skipped");
    const importedPrimary = contentOf(stack, imported.contentId)?.primaryTranscriptRevisionId;
    // Its later stages wait for an LLM and hold the lane; the user gives up on them.
    stack.h.tasks.cancel(LOCAL, imported.taskId);

    const retranscribe = new RetranscribeService({ repository: stack.h.repository, bus: stack.h.bus, control: stack.h.scheduler, disk: stack.h.disk, settings: stack.h.settings, newId: stack.h.newId });
    const chosen = stack.h.repository.withTransaction((scope) => scope.userSettings.get(LOCAL.userId)?.defaultAsrModelRef);
    const first = await retranscribe.retranscribe(LOCAL, imported.contentId, undefined, chosen);
    await waitFor(() => taskOf(stack.h, first.body.taskId).statusProjection === "succeeded");
    expect(contentOf(stack, imported.contentId)?.primaryTranscriptRevisionId).toBe(importedPrimary);
    expect(revisionsOf(stack, imported.contentId).map((revision) => revision.kind)).toEqual(["imported", "asr"]);

    const plain = await importFixture(stack);
    await waitFor(() => stageStatuses(stack.h, plain.taskId)["asr"] === "succeeded");
    const firstAsr = contentOf(stack, plain.contentId)?.primaryTranscriptRevisionId;
    stack.h.tasks.cancel(LOCAL, plain.taskId);
    const again = await retranscribe.retranscribe(LOCAL, plain.contentId, undefined, chosen);
    await waitFor(() => taskOf(stack.h, again.body.taskId).statusProjection === "succeeded");
    const revisions = revisionsOf(stack, plain.contentId);
    expect(revisions.map((revision) => revision.kind)).toEqual(["asr", "asr"]);
    expect(contentOf(stack, plain.contentId)?.primaryTranscriptRevisionId).toBe(revisions[1]?.id);
    expect(revisions[1]?.id).not.toBe(firstAsr);
    expect(fake.calls).toHaveLength(3);
  });

  it("sends the truncated effective terminology and reports what was cut", async () => {
    const { stack, fake } = setup();
    const { taskId } = await importFixture(stack);
    const setId = stack.h.newId();
    insertRow(stack.h.db, "terminology_set", { id: setId, user_id: LOCAL.userId, scope_kind: "global" });
    const terms = ["生成式软件工程", "Claude Opus 4.5", "x".repeat(50), "too many words in this one term"];
    terms.forEach((term, ordinal) =>
      insertRow(stack.h.db, "terminology_entry", { id: stack.h.newId(), set_id: setId, ordinal, term, normalized_key: term.toLowerCase() }),
    );
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");
    expect(fake.calls[0]?.input.terminology.map((entry) => entry.term)).toEqual(["生成式软件工程", "Claude Opus 4.5"]);
    expect(asrResultJson(stack, taskId)).toMatchObject({ reasons: ["terminology_truncated"], terminology: { sent: 2, droppedTooLong: 2, cutOff: 0 } });
  });

  it("an unknown outcome parks the unit, records outcome_unknown usage and is not re-sent", async () => {
    const { stack, fake } = setup();
    fake.outcomes = [amberError("asr_timeout", "connection lost after the last chunk")];
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    await waitFor(() => workUnitsOf(stack.h, taskId).some((unit) => unit.key === "asr:submit" && unit.status === "waiting_user_action"));
    await stack.h.scheduler.whenIdle();
    expect(taskOf(stack.h, taskId).statusProjection).toBe("waiting");
    expect(fake.calls).toHaveLength(1);
    expect(usageOf(stack, taskId).map((row) => row.outcome)).toEqual(["outcome_unknown"]);
  });

  it("a failure before the last chunk is retried and never recorded; a definite failure is recorded once", async () => {
    const { stack, fake } = setup();
    fake.outcomes = [amberError("asr_failed", "refused", { code: "asr_failed.unreachable" }), fakeAsrResult()];
    const ok = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, ok.taskId)).toBe("succeeded");
    expect(fake.calls).toHaveLength(2);
    expect(usageOf(stack, ok.taskId).map((row) => row.outcome)).toEqual(["succeeded"]);

    fake.outcomes = [amberError("asr_failed", "bad key", { code: "asr_failed.auth" })];
    const bad = await importFixture(stack);
    expect(await asrSettled(stack, bad.taskId)).toBe("failed");
    expect(usageOf(stack, bad.taskId).map((row) => row.outcome)).toEqual(["failed"]);
  });

  it("refuses audio over the provider's limits locally, before anything is sent", async () => {
    const { stack, fake } = setup();
    fake.capabilities = { ...fake.capabilities, maxDurationSec: 1 };
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("failed");
    expect(stageRunsOf(stack.h, taskId).find((run) => run.stage === "asr")?.error?.class).toBe("media_too_long");
    expect(fake.calls).toHaveLength(0);
    expect(usageOf(stack, taskId)).toHaveLength(0);
  });

  it("a result without speech fails as media_no_audio; an instantaneous sentence is merged, not lost", async () => {
    const { stack, fake } = setup();
    fake.outcomes = [fakeAsrResult({ text: "", segments: [{ startMs: 0, endMs: 900, text: "  " }], words: [] })];
    const silent = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, silent.taskId)).toBe("failed");
    expect(stageRunsOf(stack.h, silent.taskId).find((run) => run.stage === "asr")?.error?.class).toBe("media_no_audio");

    fake.outcomes = [
      fakeAsrResult({
        segments: [
          { startMs: 0, endMs: 1000, text: "第一句" },
          { startMs: 1000, endMs: 1000, text: "嗯" },
          { startMs: 1200, endMs: 2000, text: "Second one" },
        ],
        words: [
          { text: "第一句", startMs: 0, endMs: 1000 },
          { text: "嗯", startMs: 1000, endMs: 1000 },
          { text: "Second", startMs: 1200, endMs: 1500 },
          { text: "one", startMs: 1500, endMs: 2000 },
        ],
      }),
    ];
    const merged = await importFixture(stack);
    expect(await asrSettled(stack, merged.taskId)).toBe("succeeded");
    const revision = revisionsOf(stack, merged.contentId)[0] as TranscriptRevision;
    const segments = stack.h.repository.withTransaction((scope) => scope.transcripts.listSegments(LOCAL.userId, revision.id));
    expect(segments.map((segment) => [segment.text, segment.startMs, segment.endMs])).toEqual([
      ["第一句嗯", 0, 1000],
      ["Second one", 1200, 2000],
    ]);
    expect(segments[0]?.words?.map((word) => word.text)).toEqual(["第一句", "嗯"]);
    expect(asrResultJson(stack, merged.taskId)).toMatchObject({ reasons: ["asr_segment_merged"] });
  });
});

describe("asr stage progress", () => {
  it("fills download 0–0.4, extraction 0.4–0.5 and transcription 0.5–1 of a platform Content, never moving back", async () => {
    const h = createHarness();
    harnesses.push(h);
    const fake = new FakeAsrFactory();
    fake.progressSteps = [0.5, 1];
    h.executors.subtitle = countingExecutor({ verdict: "invalid", reasons: ["subtitle_incomplete"] });
    h.executors.asr = new AsrStageExecutor({
      repository: h.repository,
      files: new LocalFileStore(h.dir),
      ingest: reportingIngest(),
      platforms: h.platformAccess,
      asr: (provider) => (provider === fake.descriptor.provider ? fake : undefined),
      newId: h.newId,
    });
    const asrModelRef = configureAsr(h);
    const modelRef = configureLlm(h);
    const events = asrProgressEvents(h);
    const { body } = await h.importContent.import(LOCAL, { items: [{ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }], settings: { autoProofread: false, modelRef, asrModelRef } });
    h.scheduler.start();
    await h.scheduler.whenIdle();

    const taskId = body.taskIds[0] as string;
    expect(stageStatuses(h, taskId).asr).toBe("succeeded");
    // The fake download and extraction each report 0.5 then 1, the provider 0.5 then 1; success writes 1 once more.
    expect(events.filter((progress) => progress > 0)).toEqual([0.2, 0.4, 0.45, 0.5, 0.75, 1, 1]);
    expect(events).toEqual([...events].sort((a, b) => a - b));
    expect(workUnitsOf(h, taskId).map((unit) => unit.key).sort()).toEqual(["asr:submit", "media:extract_audio", "media:fetch_audio"]);
  });

  it("gives a local file's extraction the download's share too, with nothing to download", async () => {
    const { stack, fake } = setup();
    stack.h.executors.asr = new AsrStageExecutor({
      repository: stack.h.repository,
      files: stack.files,
      ingest: reportingIngest(),
      asr: (provider) => (provider === fake.descriptor.provider ? fake : undefined),
      newId: stack.h.newId,
    });
    const events = asrProgressEvents(stack.h);
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await asrSettled(stack, taskId)).toBe("succeeded");

    const moved = events.filter((progress) => progress > 0);
    // The extraction's half-way report lands at 0.25 of 0–0.5 instead of 0.45 of 0.4–0.5.
    expect(Math.min(...moved)).toBe(0.25);
    expect(moved).toContain(0.5);
    expect(moved.at(-1)).toBe(1);
    expect(events).toEqual([...events].sort((a, b) => a - b));
  });
});

// These tests wait on real timers (scheduler kicks, retry delays), as long as `settledAttempt` allows.
describe("asr stage with a job provider", { timeout: 15_000 }, () => {
  /** A job provider whose pending answers ask for the next query at once. */
  function setupJob(models?: string[]): { stack: MediaStack; fake: FakeAsrFactory; asrModelRef: AsrModelRef } {
    const fake = new FakeAsrFactory();
    fake.delivery = "job";
    const stack = createMediaStack();
    open.push(stack);
    stack.h.executors.asr = new AsrStageExecutor({
      repository: stack.h.repository,
      files: stack.files,
      ingest: stack.ingest,
      asr: (provider) => (provider === fake.descriptor.provider ? fake : undefined),
      newId: stack.h.newId,
      random: () => 0.5,
    });
    const asrModelRef = configureAsr(stack.h, LOCAL.userId, models === undefined ? {} : { models });
    return { stack, fake, asrModelRef };
  }

  const soon = { state: "pending", retryAfterMs: 1 } as const;
  // Long enough for the test to observe the wait even when the file's other tests load the machine.
  const WATCHED_WAIT_MS = 1500;
  const done = (overrides: Parameters<typeof fakeAsrResult>[0] = {}) => ({ state: "done", result: fakeAsrResult(overrides) }) as const;
  const throttled = () => amberError("asr_failed", "throttled", { code: "asr_failed.rate_limited", details: { retryAfterMs: 1 } });

  function unitsByKey(stack: MediaStack, taskId: string, key: string) {
    return workUnitsOf(stack.h, taskId).filter((unit) => unit.key === key);
  }

  async function settledAttempt(stack: MediaStack, taskId: string, attempt: number): Promise<string> {
    await waitFor(() => {
      const run = latestAttempts(stageRunsOf(stack.h, taskId)).find((candidate) => candidate.stage === "asr");
      return run !== undefined && run.attempt === attempt && ["succeeded", "failed"].includes(run.status);
    }, 15_000);
    return stageStatuses(stack.h, taskId)["asr"] as string;
  }

  it("submits once, waits between queries without holding the Task, and publishes the result", async () => {
    const { stack, fake } = setupJob();
    fake.pollOutcomes = [{ state: "pending", retryAfterMs: WATCHED_WAIT_MS }, soon, done()];
    const { taskId, contentId } = await importFixture(stack);
    stack.h.holdWakes();
    stack.h.scheduler.start();
    await waitFor(() => unitsByKey(stack, taskId, "asr:await")[0]?.retryNotBefore !== undefined);
    const waiting = stack.h.repository.withTransaction((scope) => taskWait(scope.stageRuns.listByTask(LOCAL.userId, taskId), scope.workUnits.listByTask(LOCAL.userId, taskId)));
    expect(waiting.waitingStep).toBe("awaitResult");
    expect(taskOf(stack.h, taskId).statusProjection).toBe("queued");
    stack.h.releaseWakes();

    expect(await settledAttempt(stack, taskId, 1)).toBe("succeeded");
    expect(fake.submits).toHaveLength(1);
    expect(fake.polls.map((handle) => handle.jobId)).toEqual(["job-1", "job-1", "job-1"]);
    const [submit] = unitsByKey(stack, taskId, "asr:submit");
    expect(submit).toMatchObject({ status: "succeeded", billing: "asr" });
    expect(submit?.outputRef).toBeUndefined();
    const payload = stack.h.repository.withTransaction((scope) => scope.workUnits.getResult(LOCAL.userId, submit?.id as string));
    expect(JSON.parse(payload?.payloadJson ?? "null")).toMatchObject({ version: 1, provider: "fake", jobId: "job-1" });
    const [awaited] = unitsByKey(stack, taskId, "asr:await");
    expect(awaited).toMatchObject({ status: "succeeded", outputRef: `tmp/tasks/${taskId}/asr-${awaited?.id}.json` });
    expect(awaited?.billing).toBeUndefined();
    expect(revisionsOf(stack, contentId)[0]).toMatchObject({ kind: "asr", timingFidelity: "exact_words" });
    expect(usageOf(stack, taskId).map((row) => row.outcome)).toEqual(["succeeded"]);
  });

  it("does not submit again when the terminology changes while the job runs", async () => {
    const { stack, fake } = setupJob();
    fake.pollOutcomes = [{ state: "pending", retryAfterMs: WATCHED_WAIT_MS }, done()];
    const { taskId } = await importFixture(stack);
    stack.h.holdWakes();
    stack.h.scheduler.start();
    await waitFor(() => unitsByKey(stack, taskId, "asr:await")[0]?.retryNotBefore !== undefined);
    const setId = stack.h.newId();
    insertRow(stack.h.db, "terminology_set", { id: setId, user_id: LOCAL.userId, scope_kind: "global" });
    insertRow(stack.h.db, "terminology_entry", { id: stack.h.newId(), set_id: setId, ordinal: 0, term: "生成式软件工程", normalized_key: "生成式软件工程" });
    stack.h.releaseWakes();
    expect(await settledAttempt(stack, taskId, 1)).toBe("succeeded");
    expect(fake.submits).toHaveLength(1);
    expect(fake.polls).toHaveLength(2);
  });

  it("a pending answer clears the retries transient failures spent", async () => {
    const { stack, fake } = setupJob();
    fake.pollOutcomes = [throttled(), throttled(), soon, throttled(), throttled(), done()];
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    // Four transient failures in all, never more than RETRY_MAX in a row.
    expect(await settledAttempt(stack, taskId, 1)).toBe("succeeded");
    expect(fake.polls).toHaveLength(6);
    expect(unitsByKey(stack, taskId, "asr:await")[0]?.retryCount).toBe(2);
  });

  it("fails once transient failures pass RETRY_MAX; a re-run takes the job over without submitting again", async () => {
    const { stack, fake } = setupJob();
    fake.pollOutcomes = [throttled()];
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, taskId, 1)).toBe("failed");
    expect(fake.polls).toHaveLength(RETRY_MAX + 1);
    expect(stageRunsOf(stack.h, taskId).find((run) => run.stage === "asr")?.error?.code).toBe("asr_failed.rate_limited");

    fake.pollOutcomes = [done()];
    stack.h.tasks.retryStage(LOCAL, taskId, { stage: "asr" });
    expect(await settledAttempt(stack, taskId, 2)).toBe("succeeded");
    expect(fake.submits).toHaveLength(1);
    expect(fake.polls.at(-1)?.jobId).toBe("job-1");
    expect(usageOf(stack, taskId)).toHaveLength(1);
  });

  it("a job that failed on the provider's side is submitted anew by a re-run", async () => {
    const { stack, fake } = setupJob();
    fake.pollOutcomes = [amberError("asr_failed", "job failed", { code: "asr_failed.job_failed" })];
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, taskId, 1)).toBe("failed");
    expect(JOB_ENDED_CODES.has("asr_failed.job_failed")).toBe(true);

    fake.pollOutcomes = [done()];
    stack.h.tasks.retryStage(LOCAL, taskId, { stage: "asr" });
    expect(await settledAttempt(stack, taskId, 2)).toBe("succeeded");
    expect(fake.submits).toHaveLength(2);
    expect(fake.polls.at(-1)?.jobId).toBe("job-2");
    const digests = unitsByKey(stack, taskId, "asr:submit").map((unit) => unit.inputDigest);
    expect(new Set(digests).size).toBe(2);
  });

  it("re-running with another ASR profile submits anew", async () => {
    const { stack, fake } = setupJob();
    fake.pollOutcomes = [throttled()];
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, taskId, 1)).toBe("failed");
    const other = configureAsr(stack.h, LOCAL.userId, { asDefault: false, name: "other" });
    fake.pollOutcomes = [done()];
    stack.h.tasks.retryStage(LOCAL, taskId, { stage: "asr", asrModelRef: other });
    expect(await settledAttempt(stack, taskId, 2)).toBe("succeeded");
    expect(fake.submits.map((call) => call.profileId)).toEqual([expect.any(String), other.asrProfileId]);
    expect(fake.submits[0]?.profileId).not.toBe(other.asrProfileId);
  });

  it("re-running with another model of the same profile submits anew under that model", async () => {
    const { stack, fake, asrModelRef } = setupJob(["scribe_v2", "fake-model"]);
    fake.pollOutcomes = [throttled()];
    const { taskId, contentId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, taskId, 1)).toBe("failed");
    fake.pollOutcomes = [done()];
    stack.h.tasks.retryStage(LOCAL, taskId, { stage: "asr", asrModelRef: { ...asrModelRef, modelId: "fake-model" } });
    expect(await settledAttempt(stack, taskId, 2)).toBe("succeeded");
    expect(fake.submits.map((call) => [call.profileId, call.modelId])).toEqual([
      [asrModelRef.asrProfileId, "scribe_v2"],
      [asrModelRef.asrProfileId, "fake-model"],
    ]);
    expect(usageOf(stack, taskId).map((row) => row.model)).toEqual(["scribe_v2", "fake-model"]);
    const [revision] = revisionsOf(stack, contentId);
    expect(revision?.generation).toMatchObject({ kind: "asr", asrProfileId: asrModelRef.asrProfileId, modelId: "fake-model" });
  });

  it("renaming the profile or reordering its models keeps the submission: a re-run takes the job over", async () => {
    const { stack, fake, asrModelRef } = setupJob(["scribe_v2", "fake-model"]);
    fake.pollOutcomes = [throttled()];
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, taskId, 1)).toBe("failed");
    stack.h.repository.withTransaction((scope) => {
      const profile = scope.asrProfiles.get(LOCAL.userId, asrModelRef.asrProfileId);
      scope.asrProfiles.update({ ...profile!, name: "renamed", models: [{ modelId: "fake-model" }, { modelId: "scribe_v2" }] });
    });
    fake.pollOutcomes = [done()];
    stack.h.tasks.retryStage(LOCAL, taskId, { stage: "asr" });
    expect(await settledAttempt(stack, taskId, 2)).toBe("succeeded");
    expect(fake.submits).toHaveLength(1);
    expect(fake.polls.at(-1)?.jobId).toBe("job-1");
  });

  it("a job submitted to another endpoint is not queried at the new one: a re-run after the endpoint changed submits anew", async () => {
    const { stack, fake, asrModelRef } = setupJob();
    fake.pollOutcomes = [throttled()];
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, taskId, 1)).toBe("failed");
    stack.h.repository.withTransaction((scope) => {
      const profile = scope.asrProfiles.get(LOCAL.userId, asrModelRef.asrProfileId);
      scope.asrProfiles.update({ ...profile!, baseURL: "https://relay.example.test" });
    });
    fake.pollOutcomes = [done()];
    stack.h.tasks.retryStage(LOCAL, taskId, { stage: "asr" });
    expect(await settledAttempt(stack, taskId, 2)).toBe("succeeded");
    expect(fake.submits).toHaveLength(2);
    expect(fake.polls.at(-1)?.jobId).toBe("job-2");
  });

  it("a bound model the provider no longer offers fails as model_unavailable without submitting", async () => {
    const { stack, fake, asrModelRef } = setupJob(["scribe_v2", "retired-model"]);
    const { taskId } = await importFixture(stack, { asrModelRef: { ...asrModelRef, modelId: "retired-model" } });
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, taskId, 1)).toBe("failed");
    const run = latestAttempts(stageRunsOf(stack.h, taskId)).find((candidate) => candidate.stage === "asr");
    expect(run?.error).toMatchObject({ code: "asr_failed.model_unavailable", retryDisposition: "never" });
    expect(fake.submits).toHaveLength(0);
    expect(usageOf(stack, taskId)).toHaveLength(0);
  });

  it("a typed-in model runs under its stored family; one whose family does not resolve fails as model_unavailable", async () => {
    const { stack, fake, asrModelRef } = setupJob();
    stack.h.repository.withTransaction((scope) => {
      const profile = scope.asrProfiles.get(LOCAL.userId, asrModelRef.asrProfileId);
      scope.asrProfiles.update({
        ...profile!,
        models: [{ modelId: "scribe_v2" }, { modelId: "custom/model:1", family: "fake_basic" }, { modelId: "orphan-model", family: "dropped_family" }],
      });
    });
    const custom = await importFixture(stack, { asrModelRef: { ...asrModelRef, modelId: "custom/model:1" } });
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, custom.taskId, 1)).toBe("succeeded");
    expect(fake.submits.map((call) => [call.modelId, call.family])).toEqual([["custom/model:1", "fake_basic"]]);
    expect(usageOf(stack, custom.taskId)).toEqual([expect.objectContaining({ model: "custom/model:1", feature: "transcribe", outcome: "succeeded" })]);

    const orphan = await importFixture(stack, { asrModelRef: { ...asrModelRef, modelId: "orphan-model" } });
    expect(await settledAttempt(stack, orphan.taskId, 1)).toBe("failed");
    const run = latestAttempts(stageRunsOf(stack.h, orphan.taskId)).find((candidate) => candidate.stage === "asr");
    expect(run?.error).toMatchObject({ code: "asr_failed.model_unavailable", retryDisposition: "never" });
    expect(fake.submits).toHaveLength(1);
    expect(usageOf(stack, orphan.taskId)).toHaveLength(0);
  });

  it("a job the provider no longer knows is given a grace query, then expires", async () => {
    const { stack, fake } = setupJob();
    fake.pollOutcomes = [{ state: "missing" }, done()];
    const recovered = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, recovered.taskId, 1)).toBe("succeeded");
    expect(fake.polls).toHaveLength(2);

    fake.pollOutcomes = [throttled(), throttled(), { state: "missing" }];
    const gone = await importFixture(stack);
    expect(await settledAttempt(stack, gone.taskId, 1)).toBe("failed");
    expect(stageRunsOf(stack.h, gone.taskId).find((run) => run.stage === "asr")?.error?.code).toBe("asr_failed.job_expired");
  });

  it("gives up on a job older than ASR_JOB_MAX_WAIT_HOURS without querying it", async () => {
    const { stack, fake } = setupJob();
    fake.submitOutcomes = [
      async (opts) => {
        opts.onPaidCallStart();
        return { version: 1, provider: "fake", jobId: "ancient", submittedAt: Date.now() - (ASR_JOB_MAX_WAIT_HOURS * 3_600_000 + 1) };
      },
    ];
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, taskId, 1)).toBe("failed");
    expect(stageRunsOf(stack.h, taskId).find((run) => run.stage === "asr")?.error?.code).toBe("asr_failed.job_expired");
    expect(fake.polls).toHaveLength(0);
  });

  it("publishes sentence timing only when the provider's words were dropped", async () => {
    const { stack, fake } = setupJob();
    fake.pollOutcomes = [done({ words: [] })];
    const { taskId, contentId } = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, taskId, 1)).toBe("succeeded");
    expect(revisionsOf(stack, contentId)[0]?.timingFidelity).toBe("segment_only");
    expect(asrResultJson(stack, taskId)).toMatchObject({ reasons: ["asr_words_dropped"] });
  });

  it("sends no terminology to a provider without terminology bias and says so only when there was some", async () => {
    const { stack, fake } = setupJob();
    fake.capabilities = { ...fake.capabilities, terminologyBias: false };
    const plain = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, plain.taskId, 1)).toBe("succeeded");
    expect(asrResultJson(stack, plain.taskId)).toMatchObject({ reasons: [] });

    const setId = stack.h.newId();
    insertRow(stack.h.db, "terminology_set", { id: setId, user_id: LOCAL.userId, scope_kind: "global" });
    insertRow(stack.h.db, "terminology_entry", { id: stack.h.newId(), set_id: setId, ordinal: 0, term: "生成式软件工程", normalized_key: "生成式软件工程" });
    const withTerms = await importFixture(stack);
    expect(await settledAttempt(stack, withTerms.taskId, 1)).toBe("succeeded");
    expect(fake.submits.at(-1)?.input.terminology).toEqual([]);
    expect(asrResultJson(stack, withTerms.taskId)).toMatchObject({ reasons: ["terminology_not_applied"], terminology: { sent: 0 } });
  });

  it("records usage only for a submission that reached the paid request", async () => {
    const { stack, fake } = setupJob();
    fake.failBeforeSend = true;
    fake.submitOutcomes = [amberError("asr_failed", "upload refused", { code: "asr_failed.invalid_audio" })];
    const unsent = await importFixture(stack);
    stack.h.scheduler.start();
    expect(await settledAttempt(stack, unsent.taskId, 1)).toBe("failed");
    expect(usageOf(stack, unsent.taskId)).toHaveLength(0);

    fake.failBeforeSend = false;
    fake.submitOutcomes = [amberError("asr_failed", "refused", { code: "asr_failed.invalid_audio" })];
    const sent = await importFixture(stack);
    expect(await settledAttempt(stack, sent.taskId, 1)).toBe("failed");
    expect(usageOf(stack, sent.taskId).map((row) => row.outcome)).toEqual(["failed"]);
  });

  it("an unknown outcome of the creating request parks the submission", async () => {
    const { stack, fake } = setupJob();
    fake.submitOutcomes = [amberError("asr_timeout", "no answer to the creating request")];
    const { taskId } = await importFixture(stack);
    stack.h.scheduler.start();
    await waitFor(() => unitsByKey(stack, taskId, "asr:submit")[0]?.status === "waiting_user_action");
    expect(taskOf(stack.h, taskId).statusProjection).toBe("waiting");
    expect(usageOf(stack, taskId).map((row) => row.outcome)).toEqual(["outcome_unknown"]);
    expect(fake.polls).toHaveLength(0);
  });
});

describe("asrPollDelayMs", () => {
  it("grows by half per query up to the cap, honours a bounded provider wait, and spreads by the jitter", () => {
    const middle = () => 0.5;
    expect(asrPollDelayMs(1, undefined, middle)).toBe(ASR_POLL_INTERVAL_MS);
    expect(asrPollDelayMs(2, undefined, middle)).toBe(ASR_POLL_INTERVAL_MS * 1.5);
    expect(asrPollDelayMs(50, undefined, middle)).toBe(ASR_POLL_INTERVAL_MAX_MS);
    expect(asrPollDelayMs(1, 1234, middle)).toBe(1234);
    expect(asrPollDelayMs(1, Number.MAX_SAFE_INTEGER, middle)).toBe(10 * ASR_POLL_INTERVAL_MAX_MS);
    expect(asrPollDelayMs(1, undefined, () => 0)).toBe(Math.round(ASR_POLL_INTERVAL_MS * 0.9));
    expect(asrPollDelayMs(1, undefined, () => 1)).toBe(Math.round(ASR_POLL_INTERVAL_MS * 1.1));
  });
});
