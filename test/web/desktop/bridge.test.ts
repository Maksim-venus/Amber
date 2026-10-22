import { afterEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ isTauri: vi.fn(() => false) }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: tauri.isTauri, invoke: vi.fn() }));

const { localTimeStamp, markDesktopShell } = await import("../../../src/web/desktop/bridge.ts");

afterEach(() => {
  delete document.documentElement.dataset.shell;
});

describe("markDesktopShell", () => {
  it("marks the document in the desktop window", async () => {
    tauri.isTauri.mockReturnValue(true);
    await markDesktopShell();
    expect(document.documentElement.dataset.shell).toBe("desktop");
  });

  it("leaves a browser tab unmarked", async () => {
    tauri.isTauri.mockReturnValue(false);
    await markDesktopShell();
    expect(document.documentElement.dataset.shell).toBeUndefined();
  });
});

describe("localTimeStamp", () => {
  it("formats local time as yyyyMMdd-HHmmss, zero-padded", () => {
    expect(localTimeStamp(new Date(2026, 0, 2, 3, 4, 5))).toBe("20260102-030405");
    expect(localTimeStamp(new Date(2026, 9, 19, 23, 59, 58))).toBe("20261019-235958");
  });
});
