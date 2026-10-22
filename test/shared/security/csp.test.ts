import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CSP_BASE, CSP_LOCAL_EXTRA, LOCAL_CSP, mergeCsp, SERVER_CSP, serializeCsp } from "../../../src/shared/security/csp.ts";

const tauriConf = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "src", "desktop", "tauri.conf.json"), "utf8")) as {
  app: { security: { csp: Record<string, string> }; windows: { label: string; additionalBrowserArgs?: string }[] };
};

describe("tauri.conf.json main window", () => {
  it("turns off WebView2's elastic overscroll and keeps the components wry disables by default", () => {
    const main = tauriConf.app.windows.find((window) => window.label === "main");
    // Setting the arguments replaces wry's own `--disable-features` list, so it is repeated here.
    expect(main?.additionalBrowserArgs?.split(" ")).toEqual(["--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,ElasticOverscroll"]);
  });
});

describe("CSP", () => {
  it("tauri.conf.json states exactly base + localExtra", () => {
    const expected = Object.fromEntries(Object.entries(mergeCsp(CSP_BASE, CSP_LOCAL_EXTRA)).map(([directive, sources]) => [directive, sources.join(" ")]));
    expect(tauriConf.app.security.csp).toEqual(expected);
    expect(LOCAL_CSP).toEqual(mergeCsp(CSP_BASE, CSP_LOCAL_EXTRA));
  });

  it("the server policy adds same-origin media and blobs, and nothing of the desktop", () => {
    expect(SERVER_CSP).toContain("default-src 'self'");
    expect(SERVER_CSP).toContain("media-src 'self' blob:");
    expect(SERVER_CSP).toContain("connect-src 'self';");
    expect(SERVER_CSP).not.toMatch(/ipc:|asset:|127\.0\.0\.1/u);
  });

  it("merges per directive without duplicates and serializes in order", () => {
    expect(serializeCsp(mergeCsp({ a: ["x", "y"] }, { a: ["y", "z"], b: ["w"] }))).toBe("a x y z; b w");
  });
});
