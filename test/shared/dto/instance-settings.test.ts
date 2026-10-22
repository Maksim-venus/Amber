import { describe, expect, it } from "vitest";
import { CONCURRENCY_PIPELINE_MAX } from "../../../src/shared/defaults.ts";
import { CONCURRENCY_LIMITS, INSTANCE_SETTING_KEYS, instanceSettingsPatchSchema } from "../../../src/shared/dto/instance-settings.ts";

describe("instance settings DTOs", () => {
  it("cover exactly the editable instance settings", () => {
    expect([...INSTANCE_SETTING_KEYS].sort()).toEqual(["concurrencyPipeline", "lowWaterFreeGB", "lowWaterFreeRatio", "maxDataGB", "uploadRetentionDefault"]);
  });

  it("never expose the cache location, the credential reset time or a cache move in progress", () => {
    for (const key of ["cacheRoot", "credentialsResetAt", "cacheMigration"]) {
      expect(INSTANCE_SETTING_KEYS).not.toContain(key);
      expect(instanceSettingsPatchSchema.safeParse({ concurrencyPipeline: 2, [key]: 1 }).success, key).toBe(false);
    }
  });

  it("require a non-empty patch within the ranges", () => {
    expect(instanceSettingsPatchSchema.safeParse({}).success).toBe(false);
    expect(instanceSettingsPatchSchema.safeParse({ concurrencyPipeline: 2 }).success).toBe(true);
    expect(instanceSettingsPatchSchema.safeParse({ concurrencyPipeline: 1.5 }).success).toBe(false);
    expect(instanceSettingsPatchSchema.safeParse({ lowWaterFreeRatio: 0 }).success).toBe(true);
    expect(instanceSettingsPatchSchema.safeParse({ updatedAt: 1 }).success).toBe(false);
  });

  it("refuse the removed concurrency settings", () => {
    expect(INSTANCE_SETTING_KEYS).not.toContain("concurrencyHeavy");
    expect(INSTANCE_SETTING_KEYS).not.toContain("concurrencyLlm");
    expect(instanceSettingsPatchSchema.safeParse({ concurrencyHeavy: 2 }).success).toBe(false);
    expect(instanceSettingsPatchSchema.safeParse({ concurrencyLlm: 2 }).success).toBe(false);
    expect(instanceSettingsPatchSchema.safeParse({ concurrencyPipeline: 2, concurrencyLlm: 2 }).success).toBe(false);
  });

  it("accept the one concurrency up to its named limit and refuse one more", () => {
    expect(CONCURRENCY_LIMITS).toEqual({ concurrencyPipeline: CONCURRENCY_PIPELINE_MAX });
    for (const [key, max] of Object.entries(CONCURRENCY_LIMITS)) {
      expect(instanceSettingsPatchSchema.safeParse({ [key]: max }).success).toBe(true);
      expect(instanceSettingsPatchSchema.safeParse({ [key]: max + 1 }).success).toBe(false);
      expect(instanceSettingsPatchSchema.safeParse({ [key]: 0 }).success).toBe(false);
    }
  });
});
