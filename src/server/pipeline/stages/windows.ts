import { CONTEXT_SAFETY_RATIO, LLM_MAX_OUTPUT_TOKENS_DEFAULT } from "../../../shared/defaults.ts";
import { amberError } from "../../domain/errors.ts";
import type { ModelRef } from "../../domain/model-ref.ts";
import { estimateTokens } from "../../domain/token-estimate.ts";
import type { TranscriptSegment } from "../../domain/transcript.ts";

/** Consecutive sentences sent in one call, each as one `[[s<n>]]` line with its global alias. */
export interface SentenceWindow {
  /** Position of the window's first sentence in the revision. */
  offset: number;
  segments: TranscriptSegment[];
  lines: string[];
}

/**
 * Greedy windows of consecutive sentences within the model's budget:
 * `contextWindowTokens × CONTEXT_SAFETY_RATIO − fixed part − maxOutputTokens`. `fixedTokens`
 * is the caller's prompt with an empty transcript and its longest window note, plus any
 * JSON schema it sends. Aliases are global (`s<position + 1>`) and a sentence is always one
 * physical line. Without a known window nothing is sent.
 */
export function planSentenceWindows(
  segments: readonly TranscriptSegment[],
  input: { fixedTokens: number; limits: { contextWindowTokens?: number; maxOutputTokens?: number }; modelRef: ModelRef },
): SentenceWindow[] {
  const { limits, modelRef } = input;
  const contextWindow = limits.contextWindowTokens;
  if (contextWindow === undefined) {
    throw amberError("llm_capability", "the model has no context window to plan windows against", {
      code: "llm_capability.context_window_unknown",
      details: { providerProfileId: modelRef.providerProfileId, modelId: modelRef.modelId },
    });
  }
  const budget = Math.floor(contextWindow * CONTEXT_SAFETY_RATIO) - input.fixedTokens - (limits.maxOutputTokens ?? LLM_MAX_OUTPUT_TOKENS_DEFAULT);
  if (budget <= 0) {
    throw amberError("llm_capability", "no room for any transcript in the model's budget", { code: "llm_capability.context_length" });
  }
  const windows: SentenceWindow[] = [];
  let current: SentenceWindow | undefined;
  let used = 0;
  segments.forEach((segment, position) => {
    const line = `[[s${position + 1}]] ${segment.text.replace(/\r\n|\r|\n/g, " ")}`;
    const cost = estimateTokens(`${line}\n`);
    if (cost > budget) {
      throw amberError("llm_capability", "a single sentence exceeds the model's budget", { code: "llm_capability.context_length" });
    }
    if (current === undefined || used + cost > budget) {
      current = { offset: position, segments: [], lines: [] };
      windows.push(current);
      used = 0;
    }
    current.segments.push(segment);
    current.lines.push(line);
    used += cost;
  });
  return windows;
}
