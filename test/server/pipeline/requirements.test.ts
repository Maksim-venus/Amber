import { afterEach, describe, expect, it } from "vitest";
import { asrModelRefProblem, modelRefProblem, unmetRequirement } from "../../../src/server/pipeline/requirements.ts";
import { BOB, configureAsr, configureLlm, createHarness, LOCAL, unconfiguredLlm, type Harness } from "../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

describe("stage requirements", () => {
  it("llm_configured needs an explicit owned model with a usable credential; no fallback", () => {
    const h = createHarness();
    open.push(h);
    const check = (modelRef: Parameters<typeof unmetRequirement>[2]["modelRef"], owner = LOCAL.userId) =>
      h.repository.withTransaction((scope) => unmetRequirement(scope, h.secrets, { requirement: "llm_configured", ownerUserId: owner, modelRef, asrModelRef: undefined }))?.class;
    const configured = configureLlm(h);
    expect(check(configured)).toBeUndefined();
    expect(check(undefined)).toBe("llm_unconfigured");
    expect(check(unconfiguredLlm(h))).toBe("llm_unconfigured");
    expect(check({ ...configured, modelId: "other" })).toBe("llm_unconfigured");
    expect(check(configured, BOB.userId)).toBe("llm_unconfigured");
    expect(h.repository.withTransaction((scope) => modelRefProblem(scope, LOCAL.userId, { ...configured, modelId: "other" }))).toBeDefined();
  });

  it("asr_configured needs the bound model of an owned ASR profile with a usable credential; no fallback to the default", () => {
    const h = createHarness();
    open.push(h);
    const check = (asrModelRef: Parameters<typeof unmetRequirement>[2]["asrModelRef"], owner = LOCAL.userId) =>
      h.repository.withTransaction((scope) => unmetRequirement(scope, h.secrets, { requirement: "asr_configured", ownerUserId: owner, modelRef: undefined, asrModelRef }))?.class;
    expect(check(undefined)).toBe("asr_unconfigured");
    const ref = configureAsr(h, LOCAL.userId, { models: ["scribe_v2", "scribe_v2_medical"] });
    expect(check(ref)).toBeUndefined();
    expect(check({ ...ref, modelId: "scribe_v2_medical" })).toBeUndefined();
    // The user's default does not stand in for a missing binding.
    expect(check(undefined)).toBe("asr_unconfigured");
    expect(check({ ...ref, asrProfileId: "no-such-profile" })).toBe("asr_unconfigured");
    expect(check(ref, BOB.userId)).toBe("asr_unconfigured");
    expect(check({ ...ref, modelId: "not-listed" })).toBe("asr_unconfigured");
    expect(h.repository.withTransaction((scope) => asrModelRefProblem(scope, LOCAL.userId, { ...ref, modelId: "not-listed" }))).toBeDefined();
  });

  it("asr_configured no longer holds once the bound model is removed from the profile", () => {
    const h = createHarness();
    open.push(h);
    const ref = configureAsr(h, LOCAL.userId, { models: ["scribe_v2", "scribe_v2_medical"] });
    const medical = { ...ref, modelId: "scribe_v2_medical" };
    const check = (asrModelRef: typeof ref) =>
      h.repository.withTransaction((scope) => unmetRequirement(scope, h.secrets, { requirement: "asr_configured", ownerUserId: LOCAL.userId, modelRef: undefined, asrModelRef }))?.class;
    h.repository.withTransaction((scope) => {
      const profile = scope.asrProfiles.get(LOCAL.userId, ref.asrProfileId);
      scope.asrProfiles.update({ ...profile!, models: [{ modelId: "scribe_v2" }] });
    });
    expect(check(ref)).toBeUndefined();
    expect(check(medical)).toBe("asr_unconfigured");
  });
});
