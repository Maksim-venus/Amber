import { afterEach, describe, expect, it } from "vitest";
import { ProviderService, type ModelProber } from "../../../src/server/application/providers.ts";
import { amberError, isAmberError } from "../../../src/server/domain/errors.ts";
import type { ModelRef } from "../../../src/server/domain/model-ref.ts";
import { BOB, createHarness, createTaskOfKind, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";
import { countRows } from "../../tools/sqlite.ts";

const KEY = "test-key-<placeholder-llm>";
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

/** Scripted "test connection": either measured flags or an error, counting calls. */
class FakeProber implements ModelProber {
  calls: ModelRef[] = [];
  outcome: Error | { stream: "supported" | "unsupported"; structuredOutput: "supported" | "unsupported"; tools: "supported" | "unsupported" } = {
    stream: "supported",
    structuredOutput: "unsupported",
    tools: "supported",
  };

  async probe(_userId: string, modelRef: ModelRef) {
    this.calls.push(modelRef);
    if (this.outcome instanceof Error) {
      throw this.outcome;
    }
    return { observed: { ...this.outcome }, latencyMs: 12 };
  }
}

function setup() {
  const h = createHarness();
  open.push(h);
  const prober = new FakeProber();
  let clock = 1_000;
  const service = new ProviderService({ repository: h.repository, secrets: h.secrets, prober, newId: h.newId, now: () => (clock += 1) });
  return { h, prober, service };
}

const signal = new AbortController().signal;

function create(service: ProviderService) {
  return service.create(LOCAL, {
    name: "relay",
    protocol: "openai_compatible",
    baseURL: " https://llm.invalid/v1/ ",
    models: [
      { modelId: "model-a", contextWindowTokens: 128_000, maxOutputTokens: 4_096 },
      { modelId: "model-b", contextWindowTokens: 64_000 },
    ],
  });
}

function code(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : String(error);
  }
  return undefined;
}

async function asyncCode(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : String(error);
  }
  return undefined;
}

describe("ProviderService", () => {
  it("creates profiles with all-unknown declared flags and the stated limits as a user override", () => {
    const { service } = setup();
    const created = create(service);
    expect(created).toMatchObject({ name: "relay", protocol: "openai_compatible", baseURL: "https://llm.invalid/v1", credentialStatus: "missing", hasCredential: false });
    expect(created.models.map((model) => model.modelId)).toEqual(["model-a", "model-b"]);
    const [a, b] = created.models;
    expect(a?.flags).toEqual({ declared: { stream: "unknown", tools: "unknown", structuredOutput: "unknown", vision: "unknown", audioInput: "unknown", reasoning: "unknown" } });
    expect(a?.limits).toEqual({ declared: {}, userOverride: { contextWindowTokens: 128_000, maxOutputTokens: 4_096 } });
    expect(b?.limits.userOverride).toEqual({ contextWindowTokens: 64_000 });
    expect(a?.effective.limits).toEqual({ contextWindowTokens: 128_000, maxOutputTokens: 4_096 });
    expect(service.list(LOCAL).items.map((item) => item.id)).toEqual([created.id]);
    expect(service.list(BOB).items).toEqual([]);
  });

  it("rejects duplicate model ids and non-http base URLs", () => {
    const { service } = setup();
    const duplicate = () =>
      service.create(LOCAL, {
        name: "relay",
        protocol: "anthropic_messages",
        baseURL: "https://llm.invalid",
        models: [
          { modelId: "m", contextWindowTokens: 1 },
          { modelId: "m", contextWindowTokens: 2 },
        ],
      });
    expect(code(duplicate)).toBe("invalid_request");
    expect(code(() => service.create(LOCAL, { name: "x", protocol: "anthropic_messages", baseURL: "ftp://llm.invalid", models: [] }))).toBe("invalid_request");
    expect(code(() => service.create(LOCAL, { name: "x", protocol: "anthropic_messages", baseURL: "https://u:p@llm.invalid", models: [] }))).toBe("invalid_request");
  });

  it("stores the key as one Secret, replaces it in place and never returns it", () => {
    const { h, service } = setup();
    const created = create(service);
    const configured = service.putCredential(LOCAL, created.id, KEY);
    expect(configured).toMatchObject({ credentialStatus: "configured", hasCredential: true });
    const ref = h.repository.withTransaction((scope) => scope.providerProfiles.get(LOCAL.userId, created.id)?.credentialRef) as string;
    service.putCredential(LOCAL, created.id, `${KEY}-2`);
    expect(countRows(h.db, "secret")).toBe(1);
    expect(h.secrets.reveal(LOCAL.userId, ref)).toBe(`${KEY}-2`);
    expect(JSON.stringify([configured, service.list(LOCAL)])).not.toContain(KEY);
    expect(JSON.stringify(service.list(LOCAL))).not.toContain(ref);
    expect(code(() => service.putCredential(BOB, created.id, KEY))).toBe("not_found");
  });

  it("replaces the model list, keeping measured and overridden layers of kept models", async () => {
    const { service } = setup();
    const created = create(service);
    await service.probe(LOCAL, created.id, "model-a", signal);
    service.putOverride(LOCAL, created.id, "model-a", { flags: { vision: "supported" } });
    const updated = service.update(LOCAL, created.id, {
      name: "renamed",
      baseURL: "https://other.invalid/",
      models: [
        { modelId: "model-c", contextWindowTokens: 8_000 },
        { modelId: "model-a", contextWindowTokens: 200_000 },
      ],
    });
    expect(updated).toMatchObject({ name: "renamed", baseURL: "https://other.invalid" });
    expect(updated.models.map((model) => model.modelId)).toEqual(["model-c", "model-a"]);
    const a = updated.models[1];
    expect(a?.flags.observed).toEqual({ stream: "supported", structuredOutput: "unsupported", tools: "supported" });
    expect(a?.flags.userOverride).toEqual({ vision: "supported" });
    // A restated model takes the new limits; an omitted maxOutputTokens is dropped.
    expect(a?.limits.userOverride).toEqual({ contextWindowTokens: 200_000 });
    expect(code(() => service.update(BOB, created.id, { name: "x" }))).toBe("not_found");
  });

  it("reorders the user's profiles, listing each exactly once, and refuses anything else", () => {
    const { service } = setup();
    const first = create(service);
    const second = service.create(LOCAL, { name: "second", protocol: "openai_compatible", baseURL: "https://two.invalid", models: [{ modelId: "m", contextWindowTokens: 1_000 }] });
    expect(service.list(LOCAL).items.map((p) => p.id)).toEqual([first.id, second.id]);
    expect(service.reorder(LOCAL, [second.id, first.id]).items.map((p) => p.id)).toEqual([second.id, first.id]);
    expect(service.list(LOCAL).items.map((p) => p.id)).toEqual([second.id, first.id]);
    for (const ids of [[second.id], [second.id, first.id, first.id], [second.id, first.id, "elsewhere"]]) {
      expect(code(() => service.reorder(LOCAL, ids)), JSON.stringify(ids)).toBe("invalid_request");
    }
    // Another user names profiles that are not theirs.
    expect(code(() => service.reorder(BOB, [first.id, second.id]))).toBe("invalid_request");
    expect(service.list(LOCAL).items.map((p) => p.id)).toEqual([second.id, first.id]);
  });

  it("keeps every capability layer when the model list is only reordered", async () => {
    const { service } = setup();
    const created = create(service);
    await service.probe(LOCAL, created.id, "model-a", signal);
    service.putOverride(LOCAL, created.id, "model-a", { flags: { vision: "supported" } });
    const before = service.get(LOCAL, created.id).models;
    const reordered = service.update(LOCAL, created.id, {
      models: [...before].reverse().map((model) => ({
        modelId: model.modelId,
        contextWindowTokens: model.effective.limits.contextWindowTokens as number,
        ...(model.effective.limits.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.effective.limits.maxOutputTokens }),
      })),
    });
    expect(reordered.models.map((model) => model.modelId)).toEqual(["model-b", "model-a"]);
    expect(reordered.models.find((model) => model.modelId === "model-a")).toEqual(before.find((model) => model.modelId === "model-a"));
    expect(reordered.models.find((model) => model.modelId === "model-b")).toEqual(before.find((model) => model.modelId === "model-b"));
  });

  it("refuses to remove a model or delete a profile still used by an unfinished Task", () => {
    const { h, service } = setup();
    const created = create(service);
    const taskId = createTaskOfKind(h, "process_content", { modelRef: { providerProfileId: created.id, modelId: "model-a" }, autoProofread: false });
    const keepOnlyB = () => service.update(LOCAL, created.id, { models: [{ modelId: "model-b", contextWindowTokens: 1 }] });
    expect(code(keepOnlyB)).toBe("conflict");
    // Removing the model nobody uses is fine.
    expect(code(() => service.update(LOCAL, created.id, { models: [{ modelId: "model-a", contextWindowTokens: 1 }] }))).toBeUndefined();
    expect(code(() => service.delete(LOCAL, created.id))).toBe("conflict");

    h.tasks.cancel(LOCAL, taskId);
    service.delete(LOCAL, created.id);
    expect(service.list(LOCAL).items).toEqual([]);
    expect(code(() => service.delete(LOCAL, created.id))).toBe("not_found");
  });

  it("counts a model frozen into a stage input as a reference", () => {
    const { h, service } = setup();
    const created = create(service);
    const taskId = createTaskOfKind(h, "process_content", { autoProofread: false });
    h.db.prepare("UPDATE stage_run SET input_json = ? WHERE task_id = ? AND stage = 'summary'").run(
      JSON.stringify({ modelRef: { providerProfileId: created.id, modelId: "model-b" } }),
      taskId,
    );
    expect(code(() => service.update(LOCAL, created.id, { models: [{ modelId: "model-a", contextWindowTokens: 1 }] }))).toBe("conflict");
    expect(code(() => service.delete(LOCAL, created.id))).toBe("conflict");
  });

  it("deletes the profile's Secret with it", () => {
    const { h, service } = setup();
    const created = create(service);
    service.putCredential(LOCAL, created.id, KEY);
    expect(code(() => service.delete(BOB, created.id))).toBe("not_found");
    service.delete(LOCAL, created.id);
    expect(countRows(h.db, "secret")).toBe(0);
  });

  it("writes probe results as observed flags only when the probe succeeds", async () => {
    const { prober, service } = setup();
    const created = create(service);
    prober.outcome = amberError("llm_failed", "refused", { code: "llm_failed.auth" });
    expect(await asyncCode(() => service.probe(LOCAL, created.id, "model-a", signal))).toBe("llm_failed.auth");
    expect(service.get(LOCAL, created.id).models[0]?.flags.observed).toBeUndefined();

    prober.outcome = { stream: "supported", structuredOutput: "unsupported", tools: "supported" };
    const result = await service.probe(LOCAL, created.id, "model-a", signal);
    expect(result.body).toMatchObject({ modelId: "model-a", observed: prober.outcome, latencyMs: 12 });
    const model = service.get(LOCAL, created.id).models[0];
    expect(model?.flags.observed).toEqual(prober.outcome);
    expect(model?.observedAt).toBe(result.body.observedAt);

    expect(await asyncCode(() => service.probe(LOCAL, created.id, "model-x", signal))).toBe("not_found");
    expect(await asyncCode(() => service.probe(BOB, created.id, "model-a", signal))).toBe("not_found");
    expect(prober.calls).toHaveLength(2);
  });

  it("replays a probe under the same Idempotency-Key without probing again", async () => {
    const { prober, service } = setup();
    const created = create(service);
    const first = await service.probe(LOCAL, created.id, "model-a", signal, "probe-key-1");
    const again = await service.probe(LOCAL, created.id, "model-a", signal, "probe-key-1");
    expect(again).toEqual({ ...first, replayed: true });
    expect(prober.calls).toHaveLength(1);
    expect(await asyncCode(() => service.probe(LOCAL, created.id, "model-b", signal, "probe-key-1"))).toBe("idempotency_conflict");
  });

  it("takes effective capabilities field by field: override > observed > declared", async () => {
    const { service } = setup();
    const created = create(service);
    expect(service.get(LOCAL, created.id).models[0]?.effective.flags.stream).toBe("unknown");
    await service.probe(LOCAL, created.id, "model-a", signal);
    let model = service.get(LOCAL, created.id).models[0];
    expect(model?.effective.flags).toMatchObject({ stream: "supported", structuredOutput: "unsupported", tools: "supported", vision: "unknown" });

    service.putOverride(LOCAL, created.id, "model-a", { flags: { structuredOutput: "supported", audioInput: "unsupported" }, limits: { maxOutputTokens: 1_000 } });
    model = service.get(LOCAL, created.id).models[0];
    expect(model?.effective.flags).toMatchObject({ stream: "supported", structuredOutput: "supported", tools: "supported", audioInput: "unsupported" });
    // Replacing only the flags layer leaves the limits override; null clears one field.
    expect(model?.limits.userOverride).toEqual({ maxOutputTokens: 1_000 });
    expect(model?.effective.limits).toEqual({ maxOutputTokens: 1_000 });

    service.putOverride(LOCAL, created.id, "model-a", { flags: { structuredOutput: null, audioInput: "unsupported" } });
    model = service.get(LOCAL, created.id).models[0];
    expect(model?.flags.userOverride).toEqual({ audioInput: "unsupported" });
    expect(model?.effective.flags.structuredOutput).toBe("unsupported");

    service.putOverride(LOCAL, created.id, "model-a", { flags: {}, limits: { maxOutputTokens: null } });
    model = service.get(LOCAL, created.id).models[0];
    expect(model?.flags.userOverride).toBeUndefined();
    expect(model?.limits.userOverride).toBeUndefined();
    expect(model?.effective.flags).toMatchObject({ structuredOutput: "unsupported", audioInput: "unknown" });

    expect(code(() => service.putOverride(LOCAL, created.id, "model-x", {}))).toBe("not_found");
    expect(code(() => service.putOverride(BOB, created.id, "model-a", {}))).toBe("not_found");
  });

  it("sets and clears a model's price, keeps it through model-list replacement and while the model is bound", () => {
    const { h, service } = setup();
    const created = create(service);
    const pricing = { currency: "CNY" as const, items: [{ unit: "input_tokens_per_million" as const, amount: "0.8" }, { unit: "output_tokens_per_million" as const, amount: "2.7" }], note: "free quota first" };
    const priced = service.setModelPricing(LOCAL, created.id, { modelId: "model-a", pricing });
    expect(priced.models.find((model) => model.modelId === "model-a")?.pricing).toEqual(pricing);
    expect(priced.models.find((model) => model.modelId === "model-b")).not.toHaveProperty("pricing");
    // The price stays out of the capability layers.
    expect(priced.models.find((model) => model.modelId === "model-a")?.effective).toEqual(created.models.find((model) => model.modelId === "model-a")?.effective);
    const replaced = service.update(LOCAL, created.id, { models: [{ modelId: "model-b", contextWindowTokens: 1 }, { modelId: "model-a", contextWindowTokens: 2 }] });
    expect(replaced.models.find((model) => model.modelId === "model-a")?.pricing).toEqual(pricing);
    expect(service.list(LOCAL).items[0]?.models.find((model) => model.modelId === "model-a")?.pricing).toEqual(pricing);

    createTaskOfKind(h, "process_content", { modelRef: { providerProfileId: created.id, modelId: "model-a" }, autoProofread: false });
    const perRequest = { currency: "USD" as const, items: [{ unit: "per_request" as const, amount: "0.01" }] };
    expect(service.setModelPricing(LOCAL, created.id, { modelId: "model-a", pricing: perRequest }).models.find((model) => model.modelId === "model-a")?.pricing).toEqual(perRequest);
    expect(service.setModelPricing(LOCAL, created.id, { modelId: "model-a", pricing: null }).models.find((model) => model.modelId === "model-a")).not.toHaveProperty("pricing");

    // Audio and image units belong to other sections.
    for (const unit of ["audio_per_second", "per_image"] as const) {
      expect(code(() => service.setModelPricing(LOCAL, created.id, { modelId: "model-a", pricing: { currency: "CNY", items: [{ unit, amount: "1" }] } }))).toBe("invalid_request");
    }
    expect(code(() => service.setModelPricing(LOCAL, created.id, { modelId: "model-x", pricing: null }))).toBe("not_found");
    expect(code(() => service.setModelPricing(BOB, created.id, { modelId: "model-a", pricing: perRequest }))).toBe("not_found");
    expect(service.get(LOCAL, created.id).models.find((model) => model.modelId === "model-a")).not.toHaveProperty("pricing");
  });
});

