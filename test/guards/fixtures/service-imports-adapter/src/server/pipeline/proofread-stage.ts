export async function load() {
  return import("../adapters/llm/openai-compatible/index.ts");
}
