import { describe, expect, it } from "vitest";
import { effectiveCapability, type ModelCapability } from "../../../src/server/domain/provider-profile.ts";

const declared = {
  stream: "supported",
  tools: "unknown",
  structuredOutput: "unknown",
  vision: "unsupported",
  audioInput: "unknown",
  reasoning: "unknown",
} as const;

describe("effectiveCapability", () => {
  it("merges each field as userOverride ?? observed ?? declared", () => {
    const capability: ModelCapability = {
      modelId: "relay-model",
      flags: {
        declared,
        observed: { tools: "supported", structuredOutput: "unsupported" },
        userOverride: { structuredOutput: "supported" },
      },
      limits: {
        declared: { maxOutputTokens: 4096 },
        observed: { contextWindowTokens: 64000 },
        userOverride: { contextWindowTokens: 32000 },
      },
    };
    expect(effectiveCapability(capability)).toEqual({
      flags: { ...declared, tools: "supported", structuredOutput: "supported" },
      limits: { contextWindowTokens: 32000, maxOutputTokens: 4096 },
    });
  });

  it("leaves an unknown context window absent instead of inventing one", () => {
    const capability: ModelCapability = { modelId: "m", flags: { declared }, limits: { declared: {} } };
    expect(effectiveCapability(capability).limits).toEqual({});
  });
});
