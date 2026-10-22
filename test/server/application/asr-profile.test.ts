import { afterEach, describe, expect, it } from "vitest";
import { ASR_PRESETS } from "../../../src/shared/asr-presets.ts";
import type { AsrProviderId } from "../../../src/shared/enums.ts";
import { AsrProfileService } from "../../../src/server/application/asr-profile.ts";
import { SettingsService } from "../../../src/server/application/settings.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import type { AsrProviderFactory } from "../../../src/server/ports/asr-provider.ts";
import { FakeAsrFactory } from "../../fixtures/asr/fake-asr.ts";
import { BOB, createHarness, createTaskOfKind, LOCAL, stageRunsOf, type Harness } from "../../fixtures/pipeline/harness.ts";
import { countRows } from "../../tools/sqlite.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

/** A preset-only provider: the shared preset with a scripted adapter that never goes online. */
function presetOnlyFactory(): AsrProviderFactory & { probes: number } {
  const factory = {
    descriptor: ASR_PRESETS.dashscope,
    probes: 0,
    create: () => {
      throw new Error("not used");
    },
    probe: async () => {
      factory.probes += 1;
      return {};
    },
  };
  return factory;
}

function setup() {
  const h = createHarness();
  open.push(h);
  const fake = new FakeAsrFactory();
  const presetOnly = presetOnlyFactory();
  const factories = new Map<AsrProviderId, AsrProviderFactory>([
    ["elevenlabs", fake],
    ["dashscope", presetOnly],
  ]);
  let now = 1_000;
  const service = new AsrProfileService({ repository: h.repository, secrets: h.secrets, factories, newId: h.newId, now: () => (now += 1) });
  return { h, service, fake, presetOnly };
}

function codeOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : String(error);
  }
  return undefined;
}

async function codeOfAsync(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : String(error);
  }
  return undefined;
}

const QWEN = "qwen-audio-3.1-asr-flash-filetrans";

/** Model inputs naming no family, as for models the provider knows. */
function ids(...modelIds: string[]): Array<{ modelId: string }> {
  return modelIds.map((modelId) => ({ modelId }));
}

function updateRow(h: Harness, table: string, id: string, values: Record<string, unknown>): void {
  const columns = Object.keys(values);
  h.db.prepare(`UPDATE ${table} SET ${columns.map((column) => `${column} = @${column}`).join(", ")} WHERE id = @id`).run({ ...values, id });
}

/** The ASR stage run of a Task; `status` puts it in that state. */
function asrRun(h: Harness, taskId: string, status?: string): string {
  const run = stageRunsOf(h, taskId).find((candidate) => candidate.stage === "asr");
  if (run === undefined) throw new Error("no asr stage");
  if (status !== undefined) updateRow(h, "stage_run", run.id, { status });
  return run.id;
}

/** Marks the Task's ASR job as submitted and not yet fetched. */
function submitJob(h: Harness, taskId: string): void {
  const stageRunId = asrRun(h, taskId, "running");
  h.repository.withTransaction((scope) =>
    scope.workUnits.insert(LOCAL.userId, { id: h.newId(), stageRunId, key: "asr:submit", status: "succeeded", attempt: 1, retryCount: 0, inputDigest: "s", billing: "asr" }),
  );
}

describe("AsrProfileService", () => {
  it("creates profiles with the provider's recommended models, lists them in the user's order, and never sets the default", async () => {
    const { h, service } = setup();
    const eleven = await service.create(LOCAL, { name: " ElevenLabs ", provider: "elevenlabs" });
    expect(eleven).toEqual({
      id: eleven.id,
      name: "ElevenLabs",
      provider: "elevenlabs",
      models: [{ modelId: "scribe_v2", family: "fake", available: true }],
      credentialStatus: "missing",
      hasCredential: false,
      inUse: false,
      createdAt: 1_001,
    });
    const bailian = await service.create(LOCAL, { name: "百炼", provider: "dashscope" });
    expect(bailian).toMatchObject({
      provider: "dashscope",
      models: [
        { modelId: QWEN, family: "qwen_audio", available: true },
        { modelId: "fun-asr", family: "fun_asr", available: true },
      ],
      baseURL: "https://dashscope.aliyuncs.com",
    });
    const fun = await service.create(LOCAL, { name: "百炼 fun", provider: "dashscope", models: ids("fun-asr"), baseURL: "https://dashscope.aliyuncs.com/" });
    expect(fun).toMatchObject({ models: [{ modelId: "fun-asr", available: true }], baseURL: "https://dashscope.aliyuncs.com" });
    expect(service.list(LOCAL).items.map((item) => item.id)).toEqual([eleven.id, bailian.id, fun.id]);
    expect(service.list(BOB).items).toEqual([]);
    expect(countRows(h.db, "secret")).toBe(0);
    expect(new SettingsService({ repository: h.repository }).get(LOCAL)).not.toHaveProperty("defaultAsrModelRef");
  });

  it("refuses repeated models, an unknown model without a family and, for a preset-only provider, any other endpoint", async () => {
    const { service } = setup();
    expect(await codeOfAsync(() => service.create(LOCAL, { name: "x", provider: "dashscope", models: ids("paraformer-v2") }))).toBe("invalid_request");
    expect(await codeOfAsync(() => service.create(LOCAL, { name: "x", provider: "dashscope", models: ids("fun-asr", "fun-asr") }))).toBe("invalid_request");
    expect(await codeOfAsync(() => service.create(LOCAL, { name: "x", provider: "dashscope", baseURL: "https://dashscope-intl.aliyuncs.com" }))).toBe("invalid_request");
    expect(await codeOfAsync(() => service.create(LOCAL, { name: "x", provider: "elevenlabs", models: ids("scribe_v2_realtime") }))).toBe("invalid_request");
    const custom = await service.create(LOCAL, { name: "x", provider: "elevenlabs", baseURL: "https://asr.invalid///" });
    expect(custom.baseURL).toBe("https://asr.invalid");
    expect(service.list(LOCAL).items).toHaveLength(1);
  });

  it("reorders and edits the model list, keeping a model whose family no longer resolves until it is removed", async () => {
    const { h, service } = setup();
    const profile = await service.create(LOCAL, { name: "百炼", provider: "dashscope" });
    expect((await service.update(LOCAL, profile.id, { models: ids("fun-asr", QWEN) })).models.map((model) => model.modelId)).toEqual(["fun-asr", QWEN]);
    // A model with no usable family stays readable and removable, but cannot be added.
    updateRow(h, "asr_provider_profile", profile.id, { models_json: JSON.stringify([{ modelId: "fun-asr" }, { modelId: "paraformer-v1" }, { modelId: "old-family", family: "retired" }]) });
    expect(service.list(LOCAL).items[0]?.models).toEqual([
      { modelId: "fun-asr", family: "fun_asr", available: true },
      { modelId: "paraformer-v1", available: false },
      { modelId: "old-family", available: false },
    ]);
    expect(await service.update(LOCAL, profile.id, { name: "改名" })).toMatchObject({ name: "改名" });
    expect((await service.update(LOCAL, profile.id, { models: ids("paraformer-v1", QWEN) })).models).toEqual([
      { modelId: "paraformer-v1", available: false },
      { modelId: QWEN, family: "qwen_audio", available: true },
    ]);
    // Naming a family for a kept model is a change of family, refused even when it would resolve.
    expect(await codeOfAsync(() => service.update(LOCAL, profile.id, { models: [{ modelId: "paraformer-v1", family: "fun_asr" }] }))).toBe("invalid_request");
    expect((await service.update(LOCAL, profile.id, { models: ids(QWEN) })).models).toEqual([{ modelId: QWEN, family: "qwen_audio", available: true }]);
    expect(await codeOfAsync(() => service.update(LOCAL, profile.id, { models: ids("paraformer-v1") }))).toBe("invalid_request");
    // Once removed, it may come back with a family.
    expect((await service.update(LOCAL, profile.id, { models: [{ modelId: "paraformer-v1", family: "fun_asr" }] })).models).toEqual([
      { modelId: "paraformer-v1", family: "fun_asr", available: true },
    ]);
  });

  it("adds any model id with one of the provider's families; known models take their own, kept ones keep theirs", async () => {
    const { h, service } = setup();
    const storedModels = (id: string): unknown =>
      JSON.parse((h.db.prepare("SELECT models_json FROM asr_provider_profile WHERE id = ?").get(id) as { models_json: string }).models_json);
    const profile = await service.create(LOCAL, { name: "百炼", provider: "dashscope", models: [{ modelId: "fun-asr-2026" , family: "fun_asr" }, { modelId: QWEN }, { modelId: "fun-asr", family: "fun_asr" }] });
    expect(profile.models).toEqual([
      { modelId: "fun-asr-2026", family: "fun_asr", available: true },
      { modelId: QWEN, family: "qwen_audio", available: true },
      { modelId: "fun-asr", family: "fun_asr", available: true },
    ]);
    // New entries store their family, known ones too, so they outlive a change of the known table.
    expect(storedModels(profile.id)).toEqual([
      { modelId: "fun-asr-2026", family: "fun_asr" },
      { modelId: QWEN, family: "qwen_audio" },
      { modelId: "fun-asr", family: "fun_asr" },
    ]);
    for (const models of [
      [{ modelId: "custom-x" }],
      [{ modelId: "custom-x", family: "no_such_family" }],
      [{ modelId: "fun-asr", family: "qwen_audio" }],
    ]) {
      expect(await codeOfAsync(() => service.create(LOCAL, { name: "x", provider: "dashscope", models })), JSON.stringify(models)).toBe("invalid_request");
    }
    // A kept entry keeps its family; naming another is refused (remove, then add).
    expect(await codeOfAsync(() => service.update(LOCAL, profile.id, { models: [{ modelId: "fun-asr-2026", family: "qwen_audio" }] }))).toBe("invalid_request");
    expect(await codeOfAsync(() => service.update(LOCAL, profile.id, { models: [{ modelId: QWEN, family: "fun_asr" }] }))).toBe("invalid_request");
    const kept = await service.update(LOCAL, profile.id, { models: [{ modelId: QWEN, family: "qwen_audio" }, { modelId: "fun-asr-2026", family: "fun_asr" }, { modelId: "qwen-next", family: "qwen_audio" }] });
    expect(kept.models.map((model) => [model.modelId, model.family])).toEqual([
      [QWEN, "qwen_audio"],
      ["fun-asr-2026", "fun_asr"],
      ["qwen-next", "qwen_audio"],
    ]);
    const removed = await service.update(LOCAL, profile.id, { models: ids(QWEN) });
    expect((await service.update(LOCAL, removed.id, { models: [{ modelId: QWEN }, { modelId: "fun-asr-2026", family: "qwen_audio" }] })).models[1]).toEqual({
      modelId: "fun-asr-2026",
      family: "qwen_audio",
      available: true,
    });

    // A bound custom model is locked like any other.
    const taskId = createTaskOfKind(h, "retranscribe", { asrModelRef: { asrProfileId: profile.id, modelId: "fun-asr-2026" } });
    expect(await codeOfAsync(() => service.update(LOCAL, profile.id, { models: ids(QWEN) }))).toBe("conflict");
    h.tasks.cancel(LOCAL, taskId);
    expect((await service.update(LOCAL, profile.id, { models: ids(QWEN) })).models.map((model) => model.modelId)).toEqual([QWEN]);
  });

  it("sets and clears a model's price in the transcription units, kept through list edits and while the model is bound", async () => {
    const { h, service } = setup();
    const profile = await service.create(LOCAL, { name: "百炼", provider: "dashscope" });
    const tokens = { currency: "CNY" as const, items: [{ unit: "input_tokens_per_million" as const, amount: "0.8" }, { unit: "output_tokens_per_million" as const, amount: "2.7" }] };
    const perSecond = { currency: "CNY" as const, items: [{ unit: "audio_per_second" as const, amount: "0.00022" }], note: "首 10 小时免费" };
    service.setModelPricing(LOCAL, profile.id, { modelId: QWEN, pricing: tokens });
    const priced = service.setModelPricing(LOCAL, profile.id, { modelId: "fun-asr", pricing: perSecond });
    expect(priced.models).toEqual([
      { modelId: QWEN, family: "qwen_audio", available: true, pricing: tokens },
      { modelId: "fun-asr", family: "fun_asr", available: true, pricing: perSecond },
    ]);
    const reordered = await service.update(LOCAL, profile.id, { models: [{ modelId: "fun-asr" }, { modelId: QWEN }, { modelId: "custom", family: "fun_asr" }] });
    expect(reordered.models.map((model) => model.pricing)).toEqual([perSecond, tokens, undefined]);

    const taskId = createTaskOfKind(h, "retranscribe", { asrModelRef: { asrProfileId: profile.id, modelId: QWEN } });
    expect(service.setModelPricing(LOCAL, profile.id, { modelId: QWEN, pricing: null }).models.find((model) => model.modelId === QWEN)).not.toHaveProperty("pricing");
    expect(service.setModelPricing(LOCAL, profile.id, { modelId: QWEN, pricing: tokens }).models.find((model) => model.modelId === QWEN)?.pricing).toEqual(tokens);
    h.tasks.cancel(LOCAL, taskId);

    expect(codeOf(() => service.setModelPricing(LOCAL, profile.id, { modelId: QWEN, pricing: { currency: "USD", items: [{ unit: "per_image", amount: "1" }] } }))).toBe("invalid_request");
    expect(codeOf(() => service.setModelPricing(LOCAL, profile.id, { modelId: "absent", pricing: null }))).toBe("not_found");
    expect(codeOf(() => service.setModelPricing(BOB, profile.id, { modelId: QWEN, pricing: null }))).toBe("not_found");
    expect(service.list(LOCAL).items[0]?.models.find((model) => model.modelId === QWEN)?.pricing).toEqual(tokens);
  });

  it("orders the user's profiles as given, every one exactly once", async () => {
    const { service } = setup();
    const a = await service.create(LOCAL, { name: "a", provider: "elevenlabs" });
    const b = await service.create(LOCAL, { name: "b", provider: "dashscope" });
    const c = await service.create(LOCAL, { name: "c", provider: "dashscope" });
    expect(service.reorder(LOCAL, [c.id, a.id, b.id]).items.map((item) => item.name)).toEqual(["c", "a", "b"]);
    expect(service.list(LOCAL).items.map((item) => item.name)).toEqual(["c", "a", "b"]);
    const d = await service.create(LOCAL, { name: "d", provider: "elevenlabs" });
    expect(service.list(LOCAL).items.map((item) => item.id)).toEqual([c.id, a.id, b.id, d.id]);
    for (const wrong of [[c.id, a.id, b.id], [c.id, a.id, b.id, d.id, d.id], [c.id, a.id, b.id, "missing"]]) {
      expect(codeOf(() => service.reorder(LOCAL, wrong))).toBe("invalid_request");
    }
    expect(codeOf(() => service.reorder(BOB, [a.id]))).toBe("invalid_request");
  });

  it("stores the key as a Secret, replaces it under the same reference, and does not resume waiting stages", async () => {
    const { h, service } = setup();
    let kicks = 0;
    const original = h.scheduler.kick.bind(h.scheduler);
    h.scheduler.kick = () => {
      kicks += 1;
      original();
    };
    const profile = await service.create(LOCAL, { name: "ElevenLabs", provider: "elevenlabs" });
    expect(service.putCredential(LOCAL, profile.id, "test-key-<placeholder>")).toMatchObject({ credentialStatus: "configured", hasCredential: true });
    const ref = h.repository.withTransaction((scope) => scope.asrProfiles.get(LOCAL.userId, profile.id))?.credentialRef as string;
    service.putCredential(LOCAL, profile.id, "test-key-<placeholder>-2");
    expect(h.repository.withTransaction((scope) => scope.asrProfiles.get(LOCAL.userId, profile.id))?.credentialRef).toBe(ref);
    expect(h.secrets.reveal(LOCAL.userId, ref)).toBe("test-key-<placeholder>-2");
    expect(countRows(h.db, "secret")).toBe(1);
    expect(codeOf(() => service.putCredential(BOB, profile.id, "test-key-<placeholder>"))).toBe("not_found");
    expect(kicks).toBe(0);
  });

  it("locks a bound model, the endpoint and the profile while an unfinished Task is bound, queued ones included", async () => {
    const { h, service } = setup();
    const profile = await service.create(LOCAL, { name: "百炼", provider: "dashscope" });
    const other = await service.create(LOCAL, { name: "other", provider: "dashscope" });
    // Queued: its ASR stage has not started, yet its stage run exists and binds the model.
    const taskId = createTaskOfKind(h, "retranscribe", { asrModelRef: { asrProfileId: profile.id, modelId: QWEN } });
    expect(stageRunsOf(h, taskId).find((run) => run.stage === "asr")?.status).toBe("pending");
    expect(service.list(LOCAL).items.map((item) => item.inUse)).toEqual([true, false]);
    expect(await codeOfAsync(() => service.update(LOCAL, profile.id, { models: ids("fun-asr") }))).toBe("conflict");
    expect(codeOf(() => service.delete(LOCAL, profile.id))).toBe("conflict");
    // Renaming, reordering and removing the unbound model stay allowed.
    expect(await service.update(LOCAL, profile.id, { name: "改名", models: ids(QWEN) })).toMatchObject({ name: "改名", models: [{ modelId: QWEN, available: true }] });
    expect(await service.update(LOCAL, profile.id, { models: ids("fun-asr", QWEN) })).toMatchObject({ models: [{ modelId: "fun-asr" }, { modelId: QWEN }] });
    expect(await service.update(LOCAL, profile.id, { baseURL: null })).toMatchObject({ baseURL: "https://dashscope.aliyuncs.com" });
    // Another profile is free to change.
    expect(await service.update(LOCAL, other.id, { models: ids("fun-asr") })).toMatchObject({ models: [{ modelId: "fun-asr" }] });

    h.tasks.cancel(LOCAL, taskId);
    expect(await service.update(LOCAL, profile.id, { models: ids("fun-asr") })).toMatchObject({ models: [{ modelId: "fun-asr" }], inUse: false });
    service.delete(LOCAL, profile.id);
    expect(service.list(LOCAL).items.map((item) => item.id)).toEqual([other.id]);
  });

  it("locks the endpoint of a bound profile", async () => {
    const { h, service } = setup();
    const profile = await service.create(LOCAL, { name: "ElevenLabs", provider: "elevenlabs" });
    createTaskOfKind(h, "retranscribe", { asrModelRef: { asrProfileId: profile.id, modelId: "scribe_v2" } });
    expect(await codeOfAsync(() => service.update(LOCAL, profile.id, { baseURL: "https://asr.invalid" }))).toBe("conflict");
    expect(await service.update(LOCAL, profile.id, { models: ids("scribe_v2", "fake-model") })).toMatchObject({ models: [{ modelId: "scribe_v2" }, { modelId: "fake-model" }] });
  });

  it("looks only at the latest ASR attempt: a model an earlier attempt used is free again", async () => {
    const { h, service } = setup();
    const profile = await service.create(LOCAL, { name: "百炼", provider: "dashscope" });
    const taskId = createTaskOfKind(h, "retranscribe", { asrModelRef: { asrProfileId: profile.id, modelId: QWEN } });
    const first = asrRun(h, taskId, "failed");
    h.repository.withTransaction((scope) =>
      scope.stageRuns.insert(LOCAL.userId, {
        id: h.newId(),
        taskId,
        stage: "asr",
        attempt: 2,
        status: "pending",
        progress: 0,
        dependencies: stageRunsOf(h, taskId).find((run) => run.id === first)?.dependencies ?? [],
        inputJson: JSON.stringify({ asrModelRef: { asrProfileId: profile.id, modelId: "fun-asr" } }),
      }),
    );
    expect(await service.update(LOCAL, profile.id, { models: ids("fun-asr") })).toMatchObject({ models: [{ modelId: "fun-asr" }] });
    expect(await codeOfAsync(() => service.update(LOCAL, profile.id, { models: ids(QWEN) }))).toBe("conflict");
  });

  it("refuses to replace a usable key while a submitted job awaits its result, but always lets a missing or broken key be set", async () => {
    const { h, service } = setup();
    const profile = await service.create(LOCAL, { name: "百炼", provider: "dashscope" });
    const taskId = createTaskOfKind(h, "retranscribe", { asrModelRef: { asrProfileId: profile.id, modelId: QWEN } });
    // Bound but nothing submitted (for example waiting for configuration): the key may be set and replaced.
    service.putCredential(LOCAL, profile.id, "test-key-<placeholder>");
    service.putCredential(LOCAL, profile.id, "test-key-<placeholder>-2");
    submitJob(h, taskId);
    expect(codeOf(() => service.putCredential(LOCAL, profile.id, "test-key-<placeholder>-3"))).toBe("conflict");
    // A key that can no longer be decrypted is replaced anyway: the job cannot be queried with it.
    const ref = h.repository.withTransaction((scope) => scope.asrProfiles.get(LOCAL.userId, profile.id))?.credentialRef as string;
    updateRow(h, "secret", ref, { auth_tag: Buffer.alloc(16) });
    expect(service.putCredential(LOCAL, profile.id, "test-key-<placeholder>-4")).toMatchObject({ credentialStatus: "configured" });
    expect(codeOf(() => service.putCredential(LOCAL, profile.id, "test-key-<placeholder>-5"))).toBe("conflict");
    h.tasks.cancel(LOCAL, taskId);
    expect(service.putCredential(LOCAL, profile.id, "test-key-<placeholder>-6")).toMatchObject({ credentialStatus: "configured" });
  });

  it("deletes only the owner's profile, with its Secret and the default that named it", async () => {
    const { h, service } = setup();
    const settings = new SettingsService({ repository: h.repository });
    const profile = await service.create(LOCAL, { name: "ElevenLabs", provider: "elevenlabs" });
    service.putCredential(LOCAL, profile.id, "test-key-<placeholder>");
    settings.patch(LOCAL, { defaultAsrModelRef: { asrProfileId: profile.id, modelId: "scribe_v2" } });
    expect(codeOf(() => service.delete(BOB, profile.id))).toBe("not_found");
    service.delete(LOCAL, profile.id);
    expect(countRows(h.db, "secret")).toBe(0);
    expect(settings.get(LOCAL)).not.toHaveProperty("defaultAsrModelRef");
    expect(h.repository.withTransaction((scope) => scope.userSettings.get(LOCAL.userId))?.defaultAsrModelRef).toBeUndefined();
    expect(codeOf(() => service.delete(LOCAL, profile.id))).toBe("not_found");
  });

  it("clears the default only when its own model is removed", async () => {
    const { h, service } = setup();
    const settings = new SettingsService({ repository: h.repository });
    const profile = await service.create(LOCAL, { name: "百炼", provider: "dashscope" });
    settings.patch(LOCAL, { defaultAsrModelRef: { asrProfileId: profile.id, modelId: "fun-asr" } });
    await service.update(LOCAL, profile.id, { models: ids("fun-asr") });
    expect(settings.get(LOCAL).defaultAsrModelRef).toEqual({ asrProfileId: profile.id, modelId: "fun-asr" });
    await service.update(LOCAL, profile.id, { models: ids(QWEN) });
    expect(h.repository.withTransaction((scope) => scope.userSettings.get(LOCAL.userId))?.defaultAsrModelRef).toBeUndefined();
  });

  it("keeps two users' profiles apart, even with the same name and models", async () => {
    const { service } = setup();
    const settings = (h: Harness) => new SettingsService({ repository: h.repository });
    const mine = await service.create(LOCAL, { name: "百炼", provider: "dashscope" });
    const theirs = await service.create(BOB, { name: "百炼", provider: "dashscope" });
    expect(service.list(LOCAL).items.map((item) => item.id)).toEqual([mine.id]);
    expect(service.list(BOB).items.map((item) => item.id)).toEqual([theirs.id]);
    expect(await codeOfAsync(() => service.update(BOB, mine.id, { name: "x" }))).toBe("not_found");
    expect(codeOf(() => service.delete(BOB, mine.id))).toBe("not_found");
    expect(codeOf(() => service.reorder(BOB, [mine.id]))).toBe("invalid_request");
    const h = open.at(-1) as Harness;
    expect(codeOf(() => settings(h).patch(BOB, { defaultAsrModelRef: { asrProfileId: mine.id, modelId: QWEN } }))).toBe("invalid_request");
  });

  it("probes a profile's key only when it has one, and only the owner's", async () => {
    const { service, presetOnly } = setup();
    const profile = await service.create(LOCAL, { name: "百炼", provider: "dashscope" });
    expect(await codeOfAsync(() => service.probe(LOCAL, profile.id, new AbortController().signal))).toBe("asr_unconfigured");
    service.putCredential(LOCAL, profile.id, "test-key-<placeholder>");
    expect(await codeOfAsync(() => service.probe(BOB, profile.id, new AbortController().signal))).toBe("not_found");
    expect(await service.probe(LOCAL, profile.id, new AbortController().signal)).toEqual({});
    expect(presetOnly.probes).toBe(1);
  });
});
