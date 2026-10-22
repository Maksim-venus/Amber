import type { LlmProtocol } from "./enums.ts";

/** One official endpoint of a preset vendor. */
export interface LlmPresetEndpoint {
  protocol: LlmProtocol;
  baseURL: string;
}

/**
 * Built-in Profile presets: protocol and endpoint only, never model
 * capability facts, so every model a user adds starts with all flags `unknown`. `endpoints`
 * lists the protocols the vendor officially serves, the first being the default; the custom
 * preset has none and leaves both protocol and Base URL to the user.
 */
export interface LlmPreset {
  id: string;
  name: string;
  endpoints: readonly LlmPresetEndpoint[];
}

export const LLM_PRESETS: readonly LlmPreset[] = [
  { id: "openai", name: "OpenAI", endpoints: [{ protocol: "openai_compatible", baseURL: "https://api.openai.com/v1" }] },
  { id: "anthropic", name: "Anthropic", endpoints: [{ protocol: "anthropic_messages", baseURL: "https://api.anthropic.com" }] },
  {
    id: "deepseek",
    name: "DeepSeek",
    endpoints: [
      { protocol: "openai_compatible", baseURL: "https://api.deepseek.com" },
      { protocol: "anthropic_messages", baseURL: "https://api.deepseek.com/anthropic" },
    ],
  },
  { id: "custom", name: "Custom", endpoints: [] },
];
