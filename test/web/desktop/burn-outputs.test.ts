import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../../src/web/api/client.ts";
import { burnFileName, burnOutputFormat, saveBurnProduct } from "../../../src/web/desktop/burn-outputs.ts";
import { fakeShell } from "../../fixtures/web/desktop-bridge.ts";
import { mockApi } from "../../fixtures/web/render.tsx";

vi.mock("../../../src/web/desktop/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("../../fixtures/web/desktop-bridge.ts")).fakeBridge,
}));

const GRANT = { path: "/data/assets/tmp/burn.mp4", purpose: "burn_output", expiresAt: Date.now() + 60_000, sig: "test-signature" } as const;

function routes() {
  return {
    "POST /api/media/m1/save-grant": { body: { grant: GRANT } },
    "DELETE /api/media/m1": { status: 204 },
  };
}

describe("saveBurnProduct", () => {
  it("hands the sidecar's grant to the shell and deletes the data-directory copy once saved", async () => {
    const { calls } = mockApi(routes());
    fakeShell.saveBurnOutput.mockResolvedValue({ savedPath: "D:\\视频\\第一讲.mp4" });
    const saved = await saveBurnProduct(new ApiClient({ baseUrl: "" }, "local"), "m1", burnFileName("第一讲", "video/mp4"));
    expect(saved).toEqual({ savedPath: "D:\\视频\\第一讲.mp4" });
    expect(fakeShell.saveBurnOutput).toHaveBeenCalledWith(GRANT, "第一讲.mp4");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /api/media/m1/save-grant", "DELETE /api/media/m1"]);
  });

  it("keeps the product when the user cancels the save dialog", async () => {
    const { calls } = mockApi(routes());
    fakeShell.saveBurnOutput.mockResolvedValue(null);
    expect(await saveBurnProduct(new ApiClient({ baseUrl: "" }, "local"), "m1", "x.mp4")).toBeNull();
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });
});

describe("burn product names", () => {
  it("tells the container from the MIME type and names the file after it", () => {
    expect(burnOutputFormat("video/mp4")).toBe("mp4");
    expect(burnOutputFormat("video/x-matroska")).toBe("mkv");
    expect(burnOutputFormat("video/webm")).toBeUndefined();
    expect(burnFileName("第一讲", "video/x-matroska")).toBe("第一讲.mkv");
    expect(burnFileName("第 1.5 讲", "video/mp4")).toBe("第 1.5 讲.mp4");
    // The shell appends the extension of what it recognizes.
    expect(burnFileName("第一讲", "application/octet-stream")).toBe("第一讲");
  });
});
