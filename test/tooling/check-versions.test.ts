import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkReleaseChangelog, checkVersions, hasChangelogEntry, readCargoPackageVersion, releaseVersionOf } from "../../src/tooling/check-versions.ts";

const SCRIPT = join(import.meta.dirname, "../../src/tooling/check-versions.ts");

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "amber-versions-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const cargoWithoutVersion = '[package]\nname = "amber"\nedition = "2024"\n\n[dependencies]\ntauri = { version = "2.12.0" }\n';
const cargoWithVersion = (version: string): string =>
  `[package]\nname = "amber"\nversion = "${version}"\n\n[dependencies]\ntauri = { version = "2.12.0" }\n`;

describe("checkVersions", () => {
  it("passes when the desktop files are absent", () => {
    const result = checkVersions(project({ "package.json": '{"version":"0.1.0"}' }));
    expect(result).toEqual({ ok: true, expected: "0.1.0", sources: [], mismatches: [] });
  });

  it("passes when tauri.conf.json references package.json and Cargo.toml declares no version", () => {
    const root = project({
      "package.json": '{"version":"0.1.0"}',
      "src/desktop/tauri.conf.json": '{"version":"../../package.json"}',
      "src/desktop/Cargo.toml": cargoWithoutVersion,
    });
    expect(checkVersions(root)).toMatchObject({
      ok: true,
      sources: [
        { file: "src/desktop/tauri.conf.json", version: "0.1.0" },
        { file: "src/desktop/Cargo.toml", version: null },
      ],
    });
  });

  it("accepts a literal Tauri version equal to package.json", () => {
    const root = project({ "package.json": '{"version":"0.1.0"}', "src/desktop/tauri.conf.json": '{"version":"0.1.0"}' });
    expect(checkVersions(root).ok).toBe(true);
  });

  it("rejects a Tauri version that differs or references another package.json", () => {
    const differs = project({ "package.json": '{"version":"0.1.0"}', "src/desktop/tauri.conf.json": '{"version":"0.1.1"}' });
    expect(checkVersions(differs).mismatches).toEqual([{ file: "src/desktop/tauri.conf.json", version: "0.1.1" }]);
    const elsewhere = project({
      "package.json": '{"version":"0.1.0"}',
      "src/desktop/package.json": '{"version":"0.1.0"}',
      "src/desktop/tauri.conf.json": '{"version":"./package.json"}',
    });
    expect(checkVersions(elsewhere).mismatches).toEqual([{ file: "src/desktop/tauri.conf.json", version: null }]);
  });

  it("rejects a Cargo manifest that declares a version, even an equal one", () => {
    const root = project({
      "package.json": '{"version":"0.1.0"}',
      "src/desktop/tauri.conf.json": '{"version":"../../package.json"}',
      "src/desktop/Cargo.toml": cargoWithVersion("0.1.0"),
    });
    expect(checkVersions(root).mismatches).toEqual([{ file: "src/desktop/Cargo.toml", version: "0.1.0" }]);
  });
});

describe("readCargoPackageVersion", () => {
  it("reads the [package] version and ignores dependency versions", () => {
    expect(readCargoPackageVersion(cargoWithVersion("1.2.3"))).toBe("1.2.3");
    expect(readCargoPackageVersion(cargoWithoutVersion)).toBeNull();
    expect(readCargoPackageVersion('[dependencies]\nversion = "9.9.9"\n')).toBeNull();
  });
});

const CHANGELOG = "# 变更日志\n\n## [Unreleased]\n\n### 新增\n\n- 某项\n\n## [0.1.0] - 2026-11-01\n\n### 新增\n\n- 首个公开版本\n";

describe("--release changelog requirement", () => {
  it("files a pre-release under its release version", () => {
    expect(releaseVersionOf("0.1.0-rc.3")).toBe("0.1.0");
    expect(releaseVersionOf("0.1.0-rc.final")).toBe("0.1.0");
    expect(releaseVersionOf("0.1.0+build.7")).toBe("0.1.0");
    expect(releaseVersionOf("0.1.0")).toBe("0.1.0");
  });

  it("matches only a level-two heading of exactly that version", () => {
    expect(hasChangelogEntry(CHANGELOG, "0.1.0")).toBe(true);
    expect(hasChangelogEntry(CHANGELOG, "0.1.1")).toBe(false);
    expect(hasChangelogEntry("## [0.1.01]\n", "0.1.0")).toBe(false);
    expect(hasChangelogEntry("### [0.1.0]\n", "0.1.0")).toBe(false);
    expect(hasChangelogEntry("text ## [0.1.0]\n", "0.1.0")).toBe(false);
    expect(hasChangelogEntry("## [0x1x0]\n", "0.1.0")).toBe(false);
  });

  it("requires the entry for 0.1.0-rc.3 and reports a missing changelog", () => {
    const withEntry = project({ "CHANGELOG.md": CHANGELOG });
    expect(checkReleaseChangelog(withEntry, "0.1.0-rc.3")).toBeNull();
    const unreleasedOnly = project({ "CHANGELOG.md": "# 变更日志\n\n## [Unreleased]\n" });
    expect(checkReleaseChangelog(unreleasedOnly, "0.1.0-rc.3")).toMatch(/no ## \[0\.1\.0\] entry/u);
    expect(checkReleaseChangelog(project({}), "0.1.0-rc.3")).toMatch(/missing/u);
  });

  function runCli(files: Record<string, string>, args: string[]): { status: number | null; stdout: string; stderr: string } {
    const root = project(files);
    mkdirSync(join(root, "src/tooling"), { recursive: true });
    copyFileSync(SCRIPT, join(root, "src/tooling/check-versions.ts"));
    const result = spawnSync(process.execPath, ["src/tooling/check-versions.ts", ...args], { cwd: root, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("exits non-zero with --release when 0.1.0-rc.3 has no 0.1.0 entry, and zero without --release", () => {
    const files = { "package.json": '{"version":"0.1.0-rc.3"}', "CHANGELOG.md": "## [Unreleased]\n" };
    const release = runCli(files, ["--release"]);
    expect(release.status).not.toBe(0);
    expect(release.stderr).toContain("no ## [0.1.0] entry");
    expect(runCli(files, []).status).toBe(0);
    expect(runCli({ ...files, "CHANGELOG.md": CHANGELOG }, ["--", "--release"]).status).toBe(0);
  });
});
