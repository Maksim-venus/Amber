import { describe, expect, it } from "vitest";
import { tauriOrigin } from "../../src/server/compose.ts";

describe("tauriOrigin", () => {
  it("is the WebView2 origin on Windows", () => {
    expect(tauriOrigin("win32")).toBe("http://tauri.localhost");
  });
  it("is the custom-scheme origin on macOS and Linux", () => {
    expect(tauriOrigin("darwin")).toBe("tauri://localhost");
    expect(tauriOrigin("linux")).toBe("tauri://localhost");
  });
});
