import type { ChatCompletion } from "openai";
import { transcribe } from "../../asr/fake/index.ts";

export * from "openai";

export function lastCompletion(): ChatCompletion | undefined {
  return transcribe();
}
