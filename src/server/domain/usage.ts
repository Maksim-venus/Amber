import type { AsrUsageFeature, TokenUsageFeature } from "../../shared/enums.ts";
import type { ModelRefSnapshot } from "./model-ref.ts";

/**
 * A usage row records a call that crossed the send boundary, not a successful response:
 * `outcome_unknown` calls may have been billed and are recorded too.
 */
export type UsageOutcome = "succeeded" | "failed" | "outcome_unknown";

/** One row per LLM call, attributed many-to-one to an artifact revision, task or message. */
export interface TokenUsage {
  id: string;
  userId: string;
  modelRef: ModelRefSnapshot;
  feature: TokenUsageFeature;
  taskId?: string;
  workUnitId?: string;
  artifactRevisionId?: string;
  chatMessageId?: string;
  contentId?: string;
  outcome: UsageOutcome;
  /** Absent when the upstream returned no usage or the stream broke; never faked as 0. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  rawUsageJson?: string;
  createdAt: number;
}

/** One row per ASR submission (a Task's or a model test's), measured in audio time. */
export interface AsrUsage {
  id: string;
  userId: string;
  /** Cleared when the profile is deleted; `provider` / `model` remain as the snapshot. */
  asrProfileId?: string;
  provider: string;
  model: string;
  feature: AsrUsageFeature;
  outcome: UsageOutcome;
  audioMs: number;
  taskId?: string;
  contentId?: string;
  rawUsageJson?: string;
  createdAt: number;
}
