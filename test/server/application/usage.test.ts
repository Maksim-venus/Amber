import { afterEach, describe, expect, it } from "vitest";
import { UsageService } from "../../../src/server/application/usage.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import type { AsrUsage, TokenUsage } from "../../../src/server/domain/usage.ts";
import { BOB, createHarness, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

const snapshot = (name: string, modelId = "model-a") => ({ providerProfileId: "profile-1", modelId, providerNameSnapshot: name, modelDisplaySnapshot: modelId });

function llm(id: string, createdAt: number, fields: Partial<TokenUsage> = {}): TokenUsage {
  return { id, userId: LOCAL.userId, modelRef: snapshot("relay"), feature: "summary", outcome: "succeeded", inputTokens: 10, outputTokens: 5, rawUsageJson: "{\"raw\":1}", createdAt, ...fields };
}

function asr(id: string, createdAt: number, audioMs: number, feature: AsrUsage["feature"] = "transcribe"): AsrUsage {
  return { id, userId: LOCAL.userId, provider: "elevenlabs", model: "scribe_v2", feature, outcome: "succeeded", audioMs, createdAt };
}

function setup(rows: { llm?: TokenUsage[]; asr?: AsrUsage[] }) {
  const h = createHarness();
  open.push(h);
  h.repository.withTransaction((scope) => {
    for (const row of rows.llm ?? []) scope.tokenUsage.insert(row);
    for (const row of rows.asr ?? []) scope.asrUsage.insert(row);
  });
  return new UsageService({ repository: h.repository });
}

describe("UsageService", () => {
  it("lists both kinds newest first as one timeline, with totals over the whole range", () => {
    // A broken stream reported no token counts.
    const { inputTokens: _input, outputTokens: _output, ...uncounted } = llm("l3", 200, { feature: "chat", outcome: "outcome_unknown" });
    const usage = setup({
      llm: [llm("l1", 100), llm("l2", 300, { modelRef: snapshot("renamed relay"), inputTokens: 7, outputTokens: 3 }), uncounted],
      asr: [asr("a1", 250, 50_000), asr("a2", 50, 10_000)],
    });
    const page = usage.list(LOCAL, { limit: 100 });
    expect(page.llm.map((row) => row.id)).toEqual(["l2", "l3", "l1"]);
    expect(page.asr.map((row) => row.id)).toEqual(["a1", "a2"]);
    expect(page.nextCursor).toBeUndefined();
    expect(JSON.stringify(page)).not.toContain("raw");
    expect(page.llm[1]).not.toHaveProperty("inputTokens");
    expect(page.totals).toEqual(
      expect.arrayContaining([
        { kind: "llm", modelRef: snapshot("renamed relay"), feature: "summary", calls: 2, inputTokens: 17, outputTokens: 8, incomplete: false },
        { kind: "llm", modelRef: snapshot("relay"), feature: "chat", calls: 1, incomplete: true },
        { kind: "asr", provider: "elevenlabs", model: "scribe_v2", feature: "transcribe", calls: 2, audioMs: 60_000, incomplete: false },
      ]),
    );
    expect(page.totals).toHaveLength(3);
    expect(usage.list(BOB, { limit: 100 })).toEqual({ llm: [], asr: [], totals: [] });
  });

  it("pages the merged timeline with an opaque cursor while totals stay whole", () => {
    const usage = setup({ llm: [llm("l1", 100), llm("l2", 300)], asr: [asr("a1", 300, 1_000), asr("a2", 200, 1_000)] });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = usage.list(LOCAL, { limit: 3, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...[...page.llm, ...page.asr].sort((a, b) => b.createdAt - a.createdAt).map((row) => row.id));
      expect(page.totals.find((total) => total.kind === "asr")?.calls).toBe(2);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    // Equal times order by kind, then id, both descending.
    expect(seen).toEqual(["l2", "a1", "a2", "l1"]);
    let code: string | undefined;
    try {
      usage.list(LOCAL, { limit: 3, cursor: "bm90LWEtY3Vyc29y" });
    } catch (error) {
      code = isAmberError(error) ? error.appError.code : undefined;
    }
    expect(code).toBe("invalid_request");
  });

  it("filters by time range and feature; a feature excludes ASR rows", () => {
    const usage = setup({ llm: [llm("l1", 100), llm("l2", 200, { feature: "chat" }), llm("l3", 300)], asr: [asr("a1", 200, 1)] });
    const ranged = usage.list(LOCAL, { from: 200, to: 300, limit: 10 });
    expect(ranged.llm.map((row) => row.id)).toEqual(["l2"]);
    expect(ranged.asr.map((row) => row.id)).toEqual(["a1"]);
    const chat = usage.list(LOCAL, { feature: "chat", limit: 10 });
    expect(chat.llm.map((row) => row.id)).toEqual(["l2"]);
    expect(chat.asr).toEqual([]);
    expect(chat.totals.map((total) => total.kind)).toEqual(["llm"]);
  });

  it("keeps ASR model tests apart in totals and keeps them under the test_connection filter", () => {
    const usage = setup({
      llm: [llm("l1", 100, { feature: "test_connection" }), llm("l2", 110)],
      asr: [asr("a1", 200, 60_000), asr("a2", 210, 2_000, "test_connection"), asr("a3", 220, 2_000, "test_connection")],
    });
    const all = usage.list(LOCAL, { limit: 10 });
    expect(all.asr.map((row) => [row.id, row.feature])).toEqual([
      ["a3", "test_connection"],
      ["a2", "test_connection"],
      ["a1", "transcribe"],
    ]);
    expect(all.totals.filter((total) => total.kind === "asr")).toEqual(
      expect.arrayContaining([
        { kind: "asr", provider: "elevenlabs", model: "scribe_v2", feature: "transcribe", calls: 1, audioMs: 60_000, incomplete: false },
        { kind: "asr", provider: "elevenlabs", model: "scribe_v2", feature: "test_connection", calls: 2, audioMs: 4_000, incomplete: false },
      ]),
    );
    expect(all.totals).toHaveLength(4);
    const tests = usage.list(LOCAL, { feature: "test_connection", limit: 10 });
    expect(tests.llm.map((row) => row.id)).toEqual(["l1"]);
    expect(tests.asr.map((row) => row.id)).toEqual(["a3", "a2"]);
    expect(tests.totals.map((total) => [total.kind, total.feature])).toEqual(expect.arrayContaining([["llm", "test_connection"], ["asr", "test_connection"]]));
    expect(tests.totals).toHaveLength(2);
    expect(usage.list(LOCAL, { feature: "summary", limit: 10 }).asr).toEqual([]);
  });
});
