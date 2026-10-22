import { describe, expect, it } from "vitest";
import { conditionHolds, type ConditionFacts } from "../../../src/server/pipeline/conditions.ts";

const facts = (extra: Partial<ConditionFacts> = {}): ConditionFacts => ({
  mode: "local", sourceKind: "bilibili", request: {}, primaryTranscriptKind: undefined, subtitleVerdict: undefined, hasPlatformChapters: false, ...extra,
});

describe("stage conditions", () => {
  it("needs_asr: platform subtitles judged valid make ASR unnecessary; local files always need it; an imported primary never does", () => {
    expect(conditionHolds("needs_asr", facts({ subtitleVerdict: "valid" }))).toBe(false);
    expect(conditionHolds("needs_asr", facts({ subtitleVerdict: "suspicious" }))).toBe(true);
    expect(conditionHolds("needs_asr", facts())).toBe(true);
    expect(conditionHolds("needs_asr", facts({ sourceKind: "local", subtitleVerdict: "valid" }))).toBe(true);
    expect(conditionHolds("needs_asr", facts({ sourceKind: "local", primaryTranscriptKind: "imported" }))).toBe(false);
  });

  it("evaluates the remaining conditions from request, content and mode", () => {
    expect(conditionHolds("auto_proofread_enabled", facts({ request: { autoProofread: true } }))).toBe(true);
    expect(conditionHolds("auto_proofread_enabled", facts({ request: {} }))).toBe(false);
    expect(conditionHolds("no_platform_chapters", facts({ hasPlatformChapters: true }))).toBe(false);
    expect(conditionHolds("is_local_file", facts({ sourceKind: "local" }))).toBe(true);
    expect(conditionHolds("is_local_file", facts())).toBe(false);
    expect(conditionHolds("client_only", facts({ mode: "server" }))).toBe(false);
    expect(conditionHolds("client_only", facts())).toBe(true);
  });
});
