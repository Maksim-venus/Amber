import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * `<repo>/.amber-tools/bin`, filled by `pnpm setup:tools` from the pinned Amber Runtime
 * Assets. Tests that need a tool fail here instead of skipping.
 */
export function toolsBinDir(tools: readonly string[] = ["ffmpeg", "ffprobe"]): string {
  const binDir = join(REPO_ROOT, ".amber-tools", "bin");
  const suffix = process.platform === "win32" ? ".exe" : "";
  const missing = tools.filter((tool) => !existsSync(join(binDir, `${tool}${suffix}`)));
  if (missing.length > 0) {
    throw new Error(`missing ${missing.join(", ")} in .amber-tools/bin: run \`pnpm setup:tools\` first`);
  }
  return binDir;
}

export function toolPath(tool: string): string {
  return join(toolsBinDir([tool]), process.platform === "win32" ? `${tool}.exe` : tool);
}
