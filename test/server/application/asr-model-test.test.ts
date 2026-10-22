import { afterEach, describe, expect, it } from "vitest";
import { LocalFileStore } from "../../../src/server/adapters/file-store/local-file-store.ts";
import { ASR_TEST_SCRATCH_DIR } from "../../../src/server/application/asr-model-test.ts";
import { AsrProfileService } from "../../../src/server/application/asr-profile.ts";
import { amberError, isAmberError } from "../../../src/server/domain/errors.ts";
import type { AsrProviderFactory } from "../../../src/server/ports/asr-provider.ts";
import { ASR_TEST_AUDIO_MS, ASR_TEST_POLL_INTERVAL_MS, ASR_TEST_TIMEOUT_MS } from "../../../src/shared/defaults.ts";
import type { AsrProviderId } from "../../../src/shared/enums.ts";
import { fakeAsrResult, FakeAsrFactory } from "../../fixtures/asr/fake-asr.ts";
import { BOB, createHarness, gate, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";
import { tempDataDir } from "../../tools/sqlite.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

const signal = new AbortController().signal;

/**
 * A service over a real file store in a temp directory and a fake ASR adapter. The clock
 * only moves when a test job waits, so job timing is exact and instant.
 */
async function setup(options: { realSleep?: boolean } = {}) {
  const h = createHarness();
  open.push(h);
  const fake = new FakeAsrFactory();
  const files = new LocalFileStore(tempDataDir("amber-asr-test-"));
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const service = new AsrProfileService({
    repository: h.repository,
    secrets: h.secrets,
    factories: new Map<AsrProviderId, AsrProviderFactory>([["elevenlabs", fake]]),
    files,
    newId: h.newId,
    now: () => clock,
    ...(options.realSleep === true
      ? {}
      : {
          sleep: async (ms: number) => {
            sleeps.push(ms);
            clock += ms;
          },
        }),
  });
  const profile = await service.create(LOCAL, { name: "ElevenLabs", provider: "elevenlabs", models: [{ modelId: "scribe_v2" }, { modelId: "custom-stt", family: "fake_basic" }] });
  service.putCredential(LOCAL, profile.id, "test-key-<placeholder>");
  return { h, fake, files, service, profile, sleeps };
}

async function codeOf(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : String(error);
  }
  return undefined;
}

function usageRows(h: Harness) {
  return h.repository.withTransaction((scope) => scope.asrUsage.list(LOCAL.userId, {}));
}

function storedModel(h: Harness, profileId: string, modelId: string) {
  return h.repository.withTransaction((scope) => scope.asrProfiles.get(LOCAL.userId, profileId))?.models.find((model) => model.modelId === modelId);
}

describe("AsrProfileService.testModel", () => {
  it("transcribes the generated test sound with the family's parameters, records one usage row and stores testedAt", async () => {
    const { h, fake, files, service, profile } = await setup();
    let present: { sizeBytes: number } | null = null;
    fake.outcomes = [
      async () => {
        present = await files.stat(fake.calls[0]?.input.audio.storageRef as string);
        return fakeAsrResult();
      },
    ];
    const result = await service.testModel(LOCAL, profile.id, "scribe_v2", signal);
    expect(result).toEqual({ modelId: "scribe_v2", result: "transcribed", textPreview: "欢迎来到生成式软件工程。今天讲提示词。", latencyMs: 0, testedAt: 1_000_000 });

    const call = fake.calls[0];
    expect(call?.modelId).toBe("scribe_v2");
    expect(call?.input.language).toBe("zh");
    // The family takes terminology, so exactly one test hot word goes along.
    expect(call?.input.terminology).toHaveLength(1);
    expect(call?.input.audio).toMatchObject({ mimeType: "audio/wav", durationMs: ASR_TEST_AUDIO_MS });
    expect(call?.input.audio.storageRef.startsWith(`${ASR_TEST_SCRATCH_DIR}/`)).toBe(true);
    expect(present).toEqual({ sizeBytes: call?.input.audio.sizeBytes });
    expect(await files.list(ASR_TEST_SCRATCH_DIR)).toEqual([]);

    expect(usageRows(h)).toEqual([
      expect.objectContaining({ asrProfileId: profile.id, provider: "elevenlabs", model: "scribe_v2", feature: "test_connection", outcome: "succeeded", audioMs: ASR_TEST_AUDIO_MS }),
    ]);
    expect(usageRows(h)[0]).not.toHaveProperty("taskId");
    expect(usageRows(h)[0]).not.toHaveProperty("contentId");
    expect(storedModel(h, profile.id, "scribe_v2")?.testedAt).toBe(1_000_000);
    expect(service.list(LOCAL).items[0]?.models[0]).toMatchObject({ modelId: "scribe_v2", testedAt: 1_000_000 });
  });

  it("sends no hot word for a family without terminology and shows an empty result as transcribed", async () => {
    const { fake, service, profile } = await setup();
    fake.outcomes = [fakeAsrResult({ text: "", segments: [], words: [] })];
    const result = await service.testModel(LOCAL, profile.id, "custom-stt", signal);
    expect(result).toMatchObject({ result: "transcribed", textPreview: "" });
    expect(fake.calls[0]?.input.terminology).toEqual([]);
  });

  it("reports no speech as a working model", async () => {
    const { h, fake, service, profile } = await setup();
    fake.outcomes = [amberError("media_no_audio", "no speech")];
    const result = await service.testModel(LOCAL, profile.id, "scribe_v2", signal);
    expect(result).toEqual({ modelId: "scribe_v2", result: "no_speech", latencyMs: 0, testedAt: 1_000_000 });
    expect(usageRows(h).map((row) => [row.feature, row.outcome])).toEqual([["test_connection", "succeeded"]]);
  });

  it("returns an upstream refusal as its error, records the failed call and stores nothing", async () => {
    const { h, fake, files, service, profile } = await setup();
    fake.outcomes = [amberError("asr_failed", "key refused", { code: "asr_failed.auth" })];
    expect(await codeOf(() => service.testModel(LOCAL, profile.id, "scribe_v2", signal))).toBe("asr_failed.auth");
    expect(usageRows(h).map((row) => [row.feature, row.outcome])).toEqual([["test_connection", "failed"]]);
    expect(storedModel(h, profile.id, "scribe_v2")).not.toHaveProperty("testedAt");
    expect(await files.list(ASR_TEST_SCRATCH_DIR)).toEqual([]);
    // A failure before anything was sent is not usage.
    fake.outcomes = [amberError("asr_failed", "unreachable", { code: "asr_failed.unreachable" })];
    expect(await codeOf(() => service.testModel(LOCAL, profile.id, "scribe_v2", signal))).toBe("asr_failed.unreachable");
    expect(usageRows(h)).toHaveLength(1);
  });

  it("queries a job until its result, recording the accepted submission once", async () => {
    const { h, fake, service, profile, sleeps } = await setup();
    fake.delivery = "job";
    fake.pollOutcomes = [{ state: "pending" }, { state: "pending" }, { state: "done", result: fakeAsrResult() }];
    const result = await service.testModel(LOCAL, profile.id, "scribe_v2", signal);
    expect(result).toMatchObject({ result: "transcribed", latencyMs: 3 * ASR_TEST_POLL_INTERVAL_MS });
    expect(fake.polls).toHaveLength(3);
    expect(sleeps).toEqual([ASR_TEST_POLL_INTERVAL_MS, ASR_TEST_POLL_INTERVAL_MS, ASR_TEST_POLL_INTERVAL_MS]);
    expect(fake.cancels).toEqual([]);
    expect(usageRows(h).map((row) => [row.feature, row.outcome])).toEqual([["test_connection", "succeeded"]]);
  });

  it("reports a job without a result in time as accepted, cancels it best-effort and stores no test time", async () => {
    const { h, fake, service, profile } = await setup();
    fake.delivery = "job";
    fake.pollOutcomes = [{ state: "pending" }];
    fake.cancelOutcome = new Error("cancel failed");
    const result = await service.testModel(LOCAL, profile.id, "scribe_v2", signal);
    expect(result.result).toBe("accepted");
    expect(result).not.toHaveProperty("testedAt");
    expect(result.latencyMs).toBeLessThanOrEqual(ASR_TEST_TIMEOUT_MS);
    // Every wait that ends within the limit is followed by a query.
    expect(fake.polls.length).toBe(Math.floor(ASR_TEST_TIMEOUT_MS / ASR_TEST_POLL_INTERVAL_MS));
    expect(fake.cancels).toHaveLength(1);
    expect(storedModel(h, profile.id, "scribe_v2")).not.toHaveProperty("testedAt");
    expect(usageRows(h).map((row) => [row.feature, row.outcome])).toEqual([["test_connection", "succeeded"]]);
  });

  it("treats a job the provider no longer knows as expired and no speech from the job as a working model", async () => {
    const { fake, service, profile } = await setup();
    fake.delivery = "job";
    fake.pollOutcomes = [{ state: "missing" }];
    expect(await codeOf(() => service.testModel(LOCAL, profile.id, "scribe_v2", signal))).toBe("asr_failed.job_expired");
    fake.pollOutcomes = [amberError("media_no_audio", "no speech")];
    expect((await service.testModel(LOCAL, profile.id, "scribe_v2", signal)).result).toBe("no_speech");
  });

  it("records a job submission only once the paid request was on its way", async () => {
    const { h, fake, service, profile } = await setup();
    fake.delivery = "job";
    fake.submitOutcomes = [amberError("asr_failed", "upload refused", { code: "asr_failed.invalid_audio" })];
    fake.failBeforeSend = true;
    expect(await codeOf(() => service.testModel(LOCAL, profile.id, "scribe_v2", signal))).toBe("asr_failed.invalid_audio");
    expect(usageRows(h)).toEqual([]);
    fake.failBeforeSend = false;
    expect(await codeOf(() => service.testModel(LOCAL, profile.id, "scribe_v2", signal))).toBe("asr_failed.invalid_audio");
    expect(usageRows(h).map((row) => row.outcome)).toEqual(["failed"]);
  });

  it("stops waiting when the request is aborted and removes the test sound", async () => {
    const { fake, files, service, profile } = await setup({ realSleep: true });
    const controller = new AbortController();
    fake.delivery = "job";
    fake.submitOutcomes = [
      async (opts) => {
        opts.onPaidCallStart();
        controller.abort(new Error("client went away"));
        return { version: 1, provider: "fake", jobId: "job-x", submittedAt: 1 };
      },
    ];
    await expect(service.testModel(LOCAL, profile.id, "scribe_v2", controller.signal)).rejects.toThrow("client went away");
    expect(fake.polls).toEqual([]);
    expect(await files.list(ASR_TEST_SCRATCH_DIR)).toEqual([]);
  });

  it("runs one test per model at a time", async () => {
    const { fake, service, profile } = await setup();
    const held = gate();
    fake.outcomes = [
      async () => {
        await held.promise;
        return fakeAsrResult();
      },
    ];
    const first = service.testModel(LOCAL, profile.id, "scribe_v2", signal);
    expect(await codeOf(() => service.testModel(LOCAL, profile.id, "scribe_v2", signal))).toBe("conflict");
    // Another model of the profile is free to test meanwhile.
    held.open();
    expect((await service.testModel(LOCAL, profile.id, "custom-stt", signal)).result).toBe("transcribed");
    expect((await first).result).toBe("transcribed");
    expect((await service.testModel(LOCAL, profile.id, "scribe_v2", signal)).result).toBe("transcribed");
  });

  it("refuses foreign or unknown profiles and models, models without a usable family and profiles without a key", async () => {
    const { h, fake, service, profile } = await setup();
    expect(await codeOf(() => service.testModel(BOB, profile.id, "scribe_v2", signal))).toBe("not_found");
    expect(await codeOf(() => service.testModel(LOCAL, "missing", "scribe_v2", signal))).toBe("not_found");
    expect(await codeOf(() => service.testModel(LOCAL, profile.id, "fake-model", signal))).toBe("not_found");
    h.db
      .prepare("UPDATE asr_provider_profile SET models_json = ? WHERE id = ?")
      .run(JSON.stringify([{ modelId: "scribe_v2" }, { modelId: "gone", family: "retired" }]), profile.id);
    expect(await codeOf(() => service.testModel(LOCAL, profile.id, "gone", signal))).toBe("asr_failed.model_unavailable");
    const bare = await service.create(LOCAL, { name: "no key", provider: "elevenlabs" });
    expect(await codeOf(() => service.testModel(LOCAL, bare.id, "scribe_v2", signal))).toBe("asr_unconfigured");
    expect(fake.calls).toEqual([]);
    expect(usageRows(h)).toEqual([]);
  });

  it("skips storing the test time when the model went away meanwhile", async () => {
    const { h, fake, service, profile } = await setup();
    fake.outcomes = [
      async () => {
        await service.update(LOCAL, profile.id, { models: [{ modelId: "custom-stt" }] });
        return fakeAsrResult();
      },
    ];
    const result = await service.testModel(LOCAL, profile.id, "scribe_v2", signal);
    expect(result.result).toBe("transcribed");
    expect(result).not.toHaveProperty("testedAt");
    expect(storedModel(h, profile.id, "scribe_v2")).toBeUndefined();
    expect(usageRows(h)).toHaveLength(1);
  });
});
