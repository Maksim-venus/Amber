import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * OpenAI-compatible Chat Completions fixtures, all synthetic and following the documented
 * wire format (platform.openai.com/docs/api-reference/chat, api-docs.deepseek.com, read
 * 2026-10-01); endpoints and ids are placeholders.
 * - `equivalent.sse`: the stream answering `EQUIVALENT_REQUEST`; normalizes exactly to
 *   `EQUIVALENT_GOLDEN`. Usage arrives in its own final chunk with empty `choices`.
 * - `regression.sse`: real-world shape: a keep-alive comment, `usage: null` on content
 *   chunks, `finish_reason: "length"`, cached and reasoning token breakdowns.
 * - `recorded.sse`: a real answer from a relay (2026-10-01), ids, fingerprint,
 *   timestamps and model name replaced by placeholders; that relay ignored
 *   `stream_options.include_usage`, so the stream carries no usage.
 * - `nonstream.json`: a `stream: false` answer with DeepSeek's cache-hit usage fields.
 * - `errors.json`: error answers by name, `{ status, body }`.
 */
export function openAiStream(name: "equivalent" | "regression" | "recorded"): string {
  return readFileSync(join(import.meta.dirname, `${name}.sse`), "utf8");
}

export function openAiCompletion(): string {
  return readFileSync(join(import.meta.dirname, "nonstream.json"), "utf8");
}

export interface ErrorAnswer {
  status: number;
  body: string;
}

export function openAiError(name: string): ErrorAnswer {
  const all = JSON.parse(readFileSync(join(import.meta.dirname, "errors.json"), "utf8")) as Record<string, { status: number; body: unknown }>;
  const answer = all[name];
  if (answer === undefined || name.startsWith("_")) {
    throw new Error(`no OpenAI error fixture ${name}`);
  }
  return { status: answer.status, body: JSON.stringify(answer.body) };
}
