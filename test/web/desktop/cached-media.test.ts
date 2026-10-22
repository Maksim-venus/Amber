import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../../src/web/api/client.ts";
import { saveCachedCopy } from "../../../src/web/desktop/cached-media.ts";
import { fakeShell } from "../../fixtures/web/desktop-bridge.ts";
import { mockApi } from "../../fixtures/web/render.tsx";

vi.mock("../../../src/web/desktop/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("../../fixtures/web/desktop-bridge.ts")).fakeBridge,
}));

const GRANT = { path: "C:\\Amber\\media\\第一讲.mp3", purpose: "cache_save", expiresAt: Date.now() + 60_000, sig: "test-signature" } as const;

describe("saveCachedCopy", () => {
  it("hands the sidecar's cache_save grant to the shell and keeps the cache", async () => {
    const { calls } = mockApi({ "POST /api/media/m1/save-grant": { body: { grant: GRANT } } });
    fakeShell.saveCachedMedia.mockResolvedValue({ savedPath: "D:\\音频\\第一讲.mp3" });
    const saved = await saveCachedCopy(new ApiClient({ baseUrl: "" }, "local"), "m1", "第一讲.mp3");
    expect(saved).toEqual({ savedPath: "D:\\音频\\第一讲.mp3" });
    expect(fakeShell.saveCachedMedia).toHaveBeenCalledWith(GRANT, "第一讲.mp3");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /api/media/m1/save-grant"]);
  });

  it("resolves null when the user cancels the save dialog", async () => {
    mockApi({ "POST /api/media/m1/save-grant": { body: { grant: GRANT } } });
    fakeShell.saveCachedMedia.mockResolvedValue(null);
    expect(await saveCachedCopy(new ApiClient({ baseUrl: "" }, "local"), "m1", "x.mp3")).toBeNull();
  });

  it("never opens the save dialog without a grant", async () => {
    mockApi({ "POST /api/media/m1/save-grant": { status: 409, body: { error: { class: "conflict", code: "conflict", retryDisposition: "never", userMessage: "" } } } });
    await expect(saveCachedCopy(new ApiClient({ baseUrl: "" }, "local"), "m1", "x.mp3")).rejects.toThrow();
    expect(fakeShell.saveCachedMedia).not.toHaveBeenCalled();
  });
});
