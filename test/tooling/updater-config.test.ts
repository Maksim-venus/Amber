import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderUpdaterConfig } from "../../src/tooling/updater-config.ts";

const REPO_ROOT = join(import.meta.dirname, "../..");

describe("renderUpdaterConfig", () => {
  it("points at the GitHub Releases stable feed by default and always turns on updater artifacts", () => {
    const config = renderUpdaterConfig();
    expect(config).toEqual({
      $schema: "https://schema.tauri.app/config/2",
      bundle: { createUpdaterArtifacts: true },
      plugins: { updater: { endpoints: ["https://github.com/lifefindsitsway/Amber/releases/latest/download/latest.json"] } },
    });
    const text = JSON.stringify(config);
    expect(text).not.toContain("dangerousInsecureTransportProtocol");
    expect(text).not.toContain("channel");
  });

  it("replaces the endpoint with a loopback URL for the local upgrade test, the only case allowing plain HTTP", () => {
    for (const url of ["http://127.0.0.1:8787/latest.json", "http://localhost:8787/latest.json", "https://localhost/latest.json"]) {
      const config = renderUpdaterConfig({ localTest: url });
      expect(config.plugins.updater).toEqual({ endpoints: [url], dangerousInsecureTransportProtocol: true });
      expect(config.bundle.createUpdaterArtifacts).toBe(true);
    }
  });

  it("rejects local-test URLs on any other host or scheme", () => {
    for (const url of ["http://192.168.1.2:8787/latest.json", "http://127.0.0.1.example.com/latest.json", "file:///tmp/latest.json", "ftp://localhost/x", "not a url"]) {
      expect(() => renderUpdaterConfig({ localTest: url }), url).toThrow(/--local-test/);
    }
  });

  it("exits non-zero from the command line for a rejected host without writing anything", () => {
    const result = spawnSync(process.execPath, ["src/tooling/updater-config.ts", "--local-test", "http://10.0.0.1/latest.json"], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("only accepts http(s) URLs on 127.0.0.1 or localhost");
  });
});
