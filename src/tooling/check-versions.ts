import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Single version source: only `package.json` defines the version. The Tauri
 * config must reference that file (or repeat its version exactly), and the Cargo manifest
 * must not declare `[package].version` at all: Tauri stamps the Windows executable from
 * its own config, so a Cargo version would only be a second value that can drift.
 * Either desktop file may be absent; an absent file is reported, not treated as a mismatch.
 *
 *   pnpm check:versions [-- --release]
 *
 * `--release` (the `release` build variant) also requires `CHANGELOG.md` at the repository
 * root to have an entry for the version without its pre-release suffix: `0.1.0-rc.3` needs
 * `## [0.1.0]`. The changelog is written by hand; only the entry's presence is checked.
 */

export interface VersionSource {
  file: string;
  version: string | null;
}

export interface VersionCheckResult {
  ok: boolean;
  expected: string;
  sources: VersionSource[];
  mismatches: VersionSource[];
}

const TAURI_CONFIG = "src/desktop/tauri.conf.json";
const CARGO_MANIFEST = "src/desktop/Cargo.toml";
export const CHANGELOG_FILE = "CHANGELOG.md";

/** The version a release entry is filed under: the semver core without pre-release or build suffix. */
export function releaseVersionOf(version: string): string {
  return version.replace(/[-+].*$/u, "");
}

/** Whether a Keep a Changelog document has a `## [<version>]` heading for `version`. */
export function hasChangelogEntry(changelog: string, version: string): boolean {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^##\\s+\\[${escaped}\\]`, "mu").test(changelog);
}

/** The `--release` changelog requirement; `null` when it holds, otherwise the problem. */
export function checkReleaseChangelog(rootDir: string, version: string): string | null {
  const path = join(rootDir, CHANGELOG_FILE);
  const wanted = releaseVersionOf(version);
  if (!existsSync(path)) {
    return `${CHANGELOG_FILE} is missing; a release needs its ## [${wanted}] entry`;
  }
  return hasChangelogEntry(readFileSync(path, "utf8"), wanted) ? null : `${CHANGELOG_FILE} has no ## [${wanted}] entry`;
}

export function checkVersions(rootDir: string): VersionCheckResult {
  const expected = readJsonVersion(join(rootDir, "package.json"));
  if (expected === null) {
    throw new Error("package.json has no version field");
  }
  const sources: VersionSource[] = [];
  const mismatches: VersionSource[] = [];
  const tauriPath = join(rootDir, TAURI_CONFIG);
  if (existsSync(tauriPath)) {
    const version = resolveTauriVersion(tauriPath, join(rootDir, "package.json"));
    sources.push({ file: TAURI_CONFIG, version });
    if (version !== expected) {
      mismatches.push({ file: TAURI_CONFIG, version });
    }
  }
  const cargoPath = join(rootDir, CARGO_MANIFEST);
  if (existsSync(cargoPath)) {
    const declared = readCargoPackageVersion(readFileSync(cargoPath, "utf8"));
    sources.push({ file: CARGO_MANIFEST, version: declared });
    if (declared !== null) {
      mismatches.push({ file: CARGO_MANIFEST, version: declared });
    }
  }
  return { ok: mismatches.length === 0, expected, sources, mismatches };
}

/**
 * Tauri accepts either a semver string or a path to a `package.json` (resolved against the
 * config file's directory). A path counts only if it points at the root `package.json`.
 */
function resolveTauriVersion(tauriPath: string, rootPackageJson: string): string | null {
  const version = readJsonVersion(tauriPath);
  if (version === null || !version.endsWith("package.json")) {
    return version;
  }
  const referenced = resolve(dirname(tauriPath), version);
  return referenced === resolve(rootPackageJson) ? readJsonVersion(referenced) : null;
}

function readJsonVersion(path: string): string | null {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed === "object" && parsed !== null && "version" in parsed && typeof parsed.version === "string") {
    return parsed.version;
  }
  return null;
}

/** Reads `version` from the `[package]` table only; dependency tables have their own version keys. */
export function readCargoPackageVersion(manifest: string): string | null {
  let inPackage = false;
  for (const rawLine of manifest.split(/\r?\n/)) {
    const line = rawLine.trim();
    const table = /^\[([^\]]+)\]$/.exec(line);
    if (table) {
      inPackage = table[1]?.trim() === "package";
      continue;
    }
    if (inPackage) {
      const match = /^version\s*=\s*"([^"]*)"/.exec(line);
      if (match) {
        return match[1] ?? null;
      }
    }
  }
  return null;
}

function parseArgs(argv: readonly string[]): { release: boolean } {
  let release = false;
  for (const arg of argv) {
    if (arg === "--release") {
      release = true;
    } else if (arg !== "--") {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return { release };
}

function main(): void {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const { release } = parseArgs(process.argv.slice(2));
  const result = checkVersions(root);
  console.log(`package.json: ${result.expected}`);
  for (const source of result.sources) {
    const shown =
      source.file === CARGO_MANIFEST
        ? source.version === null
          ? "no [package].version (as required)"
          : `declares ${source.version} (must not declare a version)`
        : (source.version ?? "(missing or not referencing the root package.json)");
    console.log(`${source.file}: ${shown}`);
  }
  if (result.sources.length === 0) {
    console.log(`${TAURI_CONFIG} and ${CARGO_MANIFEST} are absent; nothing to compare`);
  }
  if (!result.ok) {
    console.error(`version mismatch: ${result.mismatches.map((source) => source.file).join(", ")}`);
    process.exitCode = 1;
  }
  if (release) {
    const problem = checkReleaseChangelog(root, result.expected);
    if (problem === null) {
      console.log(`${CHANGELOG_FILE}: has ## [${releaseVersionOf(result.expected)}]`);
    } else {
      console.error(problem);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`check-versions: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
