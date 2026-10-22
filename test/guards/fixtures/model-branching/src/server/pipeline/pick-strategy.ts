export function pickStrategy(ref: { modelId: string }, model: string): string {
  if (ref.modelId.startsWith("gpt-4")) {
    return "a";
  }
  if (model === "some-relay-model") {
    return "b";
  }
  switch (model) {
    case "deepseek-chat":
      return "c";
  }
  return /^claude/.test(model) ? "d" : "e";
}
