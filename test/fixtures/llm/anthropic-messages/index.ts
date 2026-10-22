import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Anthropic Messages fixtures. All are synthetic, following the documented streaming and
 * error formats (platform.claude.com/docs/en/build-with-claude/streaming and
 * /en/api/errors, read 2026-10-01); ids are placeholders and no endpoint appears.
 * - `equivalent.sse`: answers `EQUIVALENT_REQUEST` and normalizes to `EQUIVALENT_GOLDEN`.
 * - `realistic.sse`: the shape real answers take — `ping` events, a thinking block before
 *   the text, cache token counts repeated in `message_delta`, a `max_tokens` stop.
 * - `recorded.sse`: a real answer through a relay (2026-10-01), ids and model
 *   name replaced by placeholders, everything else byte for byte.
 * - `in-stream-error.sse`: an `error` event after the stream started.
 * - `truncated.sse`: a stream that breaks off before `message_stop`.
 * - `non-stream.json`: a non-streaming answer with the equivalent text in two blocks.
 * - `errors.json`: `[status, body]` error answers by name.
 */
export function anthropicFixture(name: "equivalent.sse" | "realistic.sse" | "recorded.sse" | "in-stream-error.sse" | "truncated.sse" | "non-stream.json"): string {
  return readFileSync(join(import.meta.dirname, name), "utf8");
}

export type AnthropicErrorName =
  | "authentication"
  | "permission"
  | "billing"
  | "payment"
  | "not_found"
  | "rate_limit"
  | "overloaded"
  | "server"
  | "context_length"
  | "invalid_request"
  | "unsupported_output_config"
  | "unsupported_tools"
  | "unsupported_stream";

export function anthropicError(name: AnthropicErrorName): { status: number; body: string } {
  const { answers } = JSON.parse(readFileSync(join(import.meta.dirname, "errors.json"), "utf8")) as {
    answers: Record<string, [number, unknown]>;
  };
  const [status, body] = answers[name] as [number, unknown];
  return { status, body: JSON.stringify(body) };
}
