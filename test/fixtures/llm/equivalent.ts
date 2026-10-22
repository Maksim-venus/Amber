import type { LlmRequest, LlmStopReason, RawUsage } from "../../../src/server/domain/llm.ts";

/**
 * The request both protocol fixtures answer, and what each must normalize to. The
 * per-protocol synthetic streams (`openai-compatible/equivalent.sse`,
 * `anthropic-messages/equivalent.sse`) split the text into different deltas and spell
 * usage in their own fields; normalized, they must agree on everything below.
 */
export const EQUIVALENT_REQUEST: LlmRequest = {
  modelRef: { providerProfileId: "profile-under-test", modelId: "model-under-test" },
  system: "You are a concise assistant.",
  messages: [{ role: "user", content: [{ type: "text", text: "用一句话介绍 Amber。" }] }],
};

export interface GoldenCompletion {
  text: string;
  stopReason: LlmStopReason;
  usage: Omit<RawUsage, "rawJson">;
}

export const EQUIVALENT_GOLDEN: GoldenCompletion = {
  text: "Amber 把封存在音视频里的知识取出来，让它重新活过来。",
  stopReason: "stop",
  usage: { inputTokens: 42, outputTokens: 23 },
};
