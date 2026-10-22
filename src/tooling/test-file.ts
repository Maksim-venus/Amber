import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// `pnpm test:file -- <path>` forwards the literal `--` to the script, and vitest treats
// everything after `--` as opaque, which would silently run the whole suite instead of
// the requested files. Strip it and hand the paths to `vitest run` as filters.
const args = process.argv.slice(2);
const files = args[0] === "--" ? args.slice(1) : args;
if (files.length === 0) {
  console.error("usage: pnpm test:file -- <test file path> [...]");
  process.exit(2);
}

const vitestPackage = createRequire(import.meta.url).resolve("vitest/package.json");
const vitestBin = join(dirname(vitestPackage), "vitest.mjs");
const result = spawnSync(process.execPath, [vitestBin, "run", ...files], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
