import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { StorageSection } from "../../../../src/web/pages/settings/storage-section.tsx";
import { useContentDetail } from "../../../../src/web/pages/content/content-data.ts";
import { BYTES_PER_GB, BYTES_PER_MB } from "../../../../src/shared/units.ts";
import { CONCURRENCY_PIPELINE_MAX, SAVE_NOTICE_DISMISS_MS } from "../../../../src/shared/defaults.ts";
import type { CacheLocationDto, FileGrant } from "../../../../src/shared/dto/local-media.ts";
import { fakeShell } from "../../../fixtures/web/desktop-bridge.ts";
import { contentDetail } from "../../../fixtures/web/content-data.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

/** The cache-location commands, stubbed beside the shared fake shell; reset before every test. */
const cacheShell = vi.hoisted(() => ({
  pickCacheDir: vi.fn<() => Promise<{ path: string; grant: FileGrant } | null>>(),
  allowCacheDir: vi.fn<(grant: FileGrant) => Promise<void>>(),
  openFolder: vi.fn<(path: string) => Promise<void>>(),
}));

vi.mock("../../../../src/web/desktop/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("../../../fixtures/web/desktop-bridge.ts")).fakeBridge,
  pickCacheDir: () => cacheShell.pickCacheDir(),
  allowCacheDir: (grant: FileGrant) => cacheShell.allowCacheDir(grant),
  openFolder: (path: string) => cacheShell.openFolder(path),
}));

beforeEach(() => {
  for (const mock of Object.values(cacheShell)) mock.mockReset();
});

function server(role: "admin" | "user", storage: { usedBytes: number; storageLimitGB?: number }) {
  const api = mockApi({
    "GET /api/version": { body: { version: "0.1.0", mode: "server" } },
    "GET /api/auth/me": { body: { userId: "u1", role, mode: "server", mustChangePassword: false } },
    "GET /api/storage": { body: storage },
    "GET /api/usage": { body: { llm: [], asr: [], totals: [] } },
  });
  renderApp(<StorageSection />, { mode: "server" });
  return api;
}

describe("StorageSection in server mode", () => {
  it("shows a user their own usage against the limit and keeps the admin pointer away", async () => {
    const { calls } = server("user", { usedBytes: 70 * BYTES_PER_MB, storageLimitGB: 0.2 });
    expect(await screen.findByText("已用 70.0 MB / 配额 0.2 GB，剩余 134.8 MB")).toBeTruthy();
    await waitFor(() => expect(calls.some((call) => call.path === "/api/auth/me")).toBe(true));
    expect(screen.getByRole("progressbar", { name: "我的存储空间" }).getAttribute("aria-valuenow")).toBe("34");
    expect(screen.queryByText(/系统管理 › 实例参数/u)).toBeNull();
  });

  it("explains the shared pool when there is no limit, and points administrators to the instance parameters", async () => {
    server("admin", { usedBytes: 1024 });
    expect(await screen.findByText("已用 1.0 KB；未单独设置配额，与服务器上的其他用户共用磁盘空间")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(await screen.findByText(/系统管理 › 实例参数/u)).toBeTruthy();
  });
});

describe("AI usage", () => {
  it("names an ASR model test 「测试连接」 apart from transcription", async () => {
    const asr = { kind: "asr", provider: "dashscope", model: "fun-asr", audioMs: 2000, incomplete: false };
    mockApi({
      "GET /api/version": { body: { version: "0.1.0", mode: "server" } },
      "GET /api/auth/me": { body: { userId: "u1", role: "user", mode: "server", mustChangePassword: false } },
      "GET /api/storage": { body: { usedBytes: 0 } },
      "GET /api/usage": {
        body: {
          llm: [],
          asr: [],
          totals: [
            { ...asr, feature: "transcribe", calls: 3, audioMs: 3_600_000 },
            { ...asr, feature: "test_connection", calls: 1 },
          ],
        },
      },
    });
    renderApp(<StorageSection />, { mode: "server" });
    const rows = await screen.findAllByRole("row");
    const cells = rows.slice(1).map((row) => [...row.querySelectorAll("td")].slice(0, 3).map((cell) => cell.textContent));
    expect(cells).toEqual([
      ["dashscope · fun-asr", "语音转写", "3"],
      ["dashscope · fun-asr", "测试连接", "1"],
    ]);
  });
});

const DEFAULT_CACHE: CacheLocationDto = {
  path: "C:\\Users\\me\\AppData\\Roaming\\Amber\\media",
  isDefault: true,
  available: true,
  fileCount: 3,
  usedBytes: 700 * BYTES_PER_MB,
  maxBytes: 20 * BYTES_PER_GB,
};
const CUSTOM_CACHE: CacheLocationDto = { ...DEFAULT_CACHE, path: "D:\\Video\\media", isDefault: false };

/** Local-mode routes with the cache directory answered by `cache` (a function may vary its answer per call). */
function desktopRoutes(cache: CacheLocationDto | (() => CacheLocationDto) = DEFAULT_CACHE, extra: Parameters<typeof mockApi>[0] = {}) {
  fakeShell.desktop = true;
  return mockApi({
    "GET /api/version": { body: { version: "0.1.0", mode: "local" } },
    "GET /api/auth/me": { body: { userId: "u1", role: "admin", mode: "local", mustChangePassword: false } },
    "GET /api/usage": { body: { llm: [], asr: [], totals: [] } },
    "GET /api/media/burn-outputs": { body: [] },
    "GET /api/media/cache-location": () => ({ body: typeof cache === "function" ? cache() : cache }),
    ...extra,
  });
}

function cacheButtons() {
  const block = screen.getByTestId("cache-location");
  return {
    block,
    open: within(block).getByRole("button", { name: "打开文件夹" }),
    change: within(block).getByRole("button", { name: "更改位置…" }),
    restore: within(block).queryByRole("button", { name: "恢复默认" }),
  };
}

/** Holds the Content query the cache move must refresh; its fetches are visible in `calls`. */
function ContentProbe() {
  useContentDetail("c1");
  return null;
}

describe("StorageSection in the desktop client", () => {
  const GRANT = { path: "/data/assets/tmp/burn.mp4", purpose: "burn_output", expiresAt: Date.now() + 60_000, sig: "test-signature" };

  function desktop() {
    let outputs = [
      { assetId: "m1", contentId: "c1", taskId: "t1", title: "第一讲", mimeType: "video/x-matroska", sizeBytes: 3 * BYTES_PER_MB, createdAt: Date.UTC(2026, 9, 1) },
      { assetId: "m2", contentId: "c2", taskId: "t2", mimeType: "video/mp4", sizeBytes: 1024, createdAt: Date.UTC(2026, 9, 2) },
    ];
    const api = desktopRoutes(DEFAULT_CACHE, {
      "GET /api/media/burn-outputs": () => ({ body: outputs }),
      "POST /api/media/m1/save-grant": { body: { grant: GRANT } },
      "POST /api/media/m2/save-grant": { body: { grant: GRANT } },
      "DELETE /api/media/m1": () => {
        outputs = outputs.filter((item) => item.assetId !== "m1");
        return { status: 204 };
      },
      "DELETE /api/media/m2": () => {
        outputs = outputs.filter((item) => item.assetId !== "m2");
        return { status: 204 };
      },
    });
    renderApp(<StorageSection />, { mode: "local" });
    return api;
  }

  it("lists burn products with their format and saves one where the user chooses, deleting the copy only once saved", async () => {
    fakeShell.saveBurnOutput.mockResolvedValueOnce(null).mockResolvedValueOnce({ savedPath: "D:\\第一讲.mkv" });
    const { calls } = desktop();
    await waitFor(() => expect(screen.getAllByTestId("burn-output")).toHaveLength(2));
    const [first, second] = screen.getAllByTestId("burn-output");
    expect(first?.textContent).toContain("第一讲");
    expect(first?.textContent).toContain("3.0 MB");
    expect(second?.textContent).toContain("未命名内容");
    expect(screen.getAllByTestId("burn-output-format").map((item) => item.textContent)).toEqual(["MKV", "MP4"]);
    fireEvent.click(within(first as HTMLElement).getByRole("button", { name: "另存为…" }));
    await waitFor(() => expect(fakeShell.saveBurnOutput).toHaveBeenCalledTimes(1));
    expect(fakeShell.saveBurnOutput).toHaveBeenCalledWith(GRANT, "第一讲.mkv");
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    fireEvent.click(within(first as HTMLElement).getByRole("button", { name: "另存为…" }));
    expect((await screen.findByTestId("burn-output-saved")).textContent).toBe("已保存到 D:\\第一讲.mkv");
    await waitFor(() => expect(screen.getAllByTestId("burn-output")).toHaveLength(1));
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual(["/api/media/m1"]);
  });

  it("closes the saved notice when asked, or on its own after a while", async () => {
    fakeShell.saveBurnOutput.mockResolvedValueOnce({ savedPath: "D:\\第一讲.mkv" }).mockResolvedValueOnce({ savedPath: "D:\\未命名内容.mp4" });
    desktop();
    await waitFor(() => expect(screen.getAllByTestId("burn-output")).toHaveLength(2));
    fireEvent.click(within(screen.getAllByTestId("burn-output")[0] as HTMLElement).getByRole("button", { name: "另存为…" }));
    fireEvent.click(within(await screen.findByTestId("burn-output-saved")).getByRole("button", { name: "关闭" }));
    expect(screen.queryByTestId("burn-output-saved")).toBeNull();
    await waitFor(() => expect(screen.getAllByTestId("burn-output")).toHaveLength(1));

    // The clock stands still while the save settles, so the dismiss timer starts at a known time.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => void vi.useRealTimers());
    const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
    fireEvent.click(within(screen.getByTestId("burn-output")).getByRole("button", { name: "另存为…" }));
    for (let round = 0; round < 50 && screen.queryByTestId("burn-output-saved") === null; round += 1) await tick(0);
    expect(screen.getByTestId("burn-output-saved").textContent).toBe("已保存到 D:\\未命名内容.mp4");
    await tick(SAVE_NOTICE_DISMISS_MS - 1);
    expect(screen.getByTestId("burn-output-saved")).toBeTruthy();
    await tick(1);
    expect(screen.queryByTestId("burn-output-saved")).toBeNull();
  });

  it("deletes a burn product after confirmation and offers the credential reset", async () => {
    const { calls } = desktop();
    await waitFor(() => expect(screen.getAllByTestId("burn-output")).toHaveLength(2));
    const second = screen.getAllByTestId("burn-output")[1] as HTMLElement;
    fireEvent.click(within(second).getByRole("button", { name: "删除" }));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "确认" }));
    await waitFor(() => expect(screen.getAllByTestId("burn-output")).toHaveLength(1));
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual(["/api/media/m2"]);
    expect(screen.getByRole("button", { name: "重置全部凭据" })).toBeTruthy();
  });

  it("shows neither outside the desktop client", async () => {
    mockApi({
      "GET /api/version": { body: { version: "0.1.0", mode: "local" } },
      "GET /api/auth/me": { body: { userId: "u1", role: "admin", mode: "local", mustChangePassword: false } },
      "GET /api/usage": { body: { llm: [], asr: [], totals: [] } },
    });
    renderApp(<StorageSection />, { mode: "local" });
    expect(await screen.findByText("暂无用量记录")).toBeTruthy();
    expect(screen.queryByText("待保存的导出视频")).toBeNull();
    expect(screen.queryByText("本地缓存")).toBeNull();
    expect(screen.queryByRole("button", { name: "重置全部凭据" })).toBeNull();
  });
});

describe("cache directory block", () => {
  const PICKED = { path: "E:\\Media\\media", grant: { path: "E:\\Media\\media", purpose: "cache_dir" as const, expiresAt: Date.now() + 60_000, sig: "test-signature" } };

  it("shows the default location with its usage, opens the folder, and offers no restore while the default is in use", async () => {
    cacheShell.openFolder.mockResolvedValue(undefined);
    desktopRoutes();
    renderApp(<StorageSection />, { mode: "local" });
    expect((await screen.findByTestId("cache-path")).textContent).toBe(DEFAULT_CACHE.path);
    expect(screen.getByText("Amber 缓存：700.0 MB / 20.0 GB（3 个文件）")).toBeTruthy();
    expect(screen.getByText(/「卸载并删除全部数据」时仍会一起删除/u)).toBeTruthy();
    const buttons = cacheButtons();
    expect(buttons.restore).toBeNull();
    expect(screen.queryByTestId("cache-unavailable")).toBeNull();
    fireEvent.click(buttons.open);
    await waitFor(() => expect(cacheShell.openFolder).toHaveBeenCalledWith(DEFAULT_CACHE.path));
  });

  it("warns when the custom location is unavailable and keeps only the folder button disabled", async () => {
    desktopRoutes({ ...CUSTOM_CACHE, available: false });
    renderApp(<StorageSection />, { mode: "local" });
    const warning = await screen.findByTestId("cache-unavailable");
    expect(warning.textContent).toContain("缓存位置不可用");
    expect(warning.textContent).toContain("重新接入该磁盘");
    expect(warning.textContent).toContain("旧缓存会被放弃");
    const buttons = cacheButtons();
    expect((buttons.open as HTMLButtonElement).disabled).toBe(true);
    expect((buttons.change as HTMLButtonElement).disabled).toBe(false);
    expect((buttons.restore as HTMLButtonElement).disabled).toBe(false);
  });

  it("reports copy progress or the pending cleanup and locks every control meanwhile", async () => {
    desktopRoutes({ ...CUSTOM_CACHE, migration: { phase: "copying", copiedBytes: 100 * BYTES_PER_MB, totalBytes: 700 * BYTES_PER_MB, fileCount: 3 } });
    const first = renderApp(<StorageSection />, { mode: "local" });
    expect((await screen.findByTestId("cache-progress")).textContent).toBe("正在迁移 100.0 MB / 700.0 MB（3 个文件）…");
    let buttons = cacheButtons();
    expect([buttons.open, buttons.change, buttons.restore].map((button) => (button as HTMLButtonElement).disabled)).toEqual([true, true, true]);
    first.unmount();

    desktopRoutes({ ...CUSTOM_CACHE, migration: { phase: "cleanup_pending" } });
    renderApp(<StorageSection />, { mode: "local" });
    expect((await screen.findByTestId("cache-progress")).textContent).toBe("正在清理原位置的旧文件…");
    buttons = cacheButtons();
    expect([buttons.open, buttons.change, buttons.restore].map((button) => (button as HTMLButtonElement).disabled)).toEqual([true, true, true]);
  });

  it("explains a failed move with the error's message and leaves the controls usable", async () => {
    desktopRoutes({
      ...CUSTOM_CACHE,
      migration: { phase: "failed", error: { class: "disk_low", code: "disk_low", retryDisposition: "policy", userMessage: "磁盘空间不足，已暂停新任务" } },
    });
    renderApp(<StorageSection />, { mode: "local" });
    const failed = await screen.findByTestId("cache-failed");
    expect(failed.textContent).toContain("上次更改位置未完成");
    expect(failed.textContent).toContain("磁盘空间不足，已暂停新任务");
    const buttons = cacheButtons();
    expect([buttons.open, buttons.change, buttons.restore].map((button) => (button as HTMLButtonElement).disabled)).toEqual([false, false, false]);
  });

  it("moves the cache as soon as a folder is picked: pick, allow the directory, then PUT, and polls until the move ends", async () => {
    const order: string[] = [];
    cacheShell.pickCacheDir.mockResolvedValueOnce(null).mockResolvedValueOnce(PICKED);
    cacheShell.allowCacheDir.mockImplementation(async () => {
      order.push("allow");
    });
    let moved = false;
    const { calls } = desktopRoutes(
      () => (moved ? { ...CUSTOM_CACHE, path: PICKED.path } : DEFAULT_CACHE),
      {
        "PUT /api/media/cache-location": () => {
          order.push("put");
          moved = true;
          return { status: 202, body: { ...DEFAULT_CACHE, migration: { phase: "copying", copiedBytes: 0, totalBytes: 700 * BYTES_PER_MB, fileCount: 3 } } };
        },
        "GET /api/contents/c1": { body: contentDetail() },
      },
    );
    renderApp(
      <>
        <StorageSection />
        <ContentProbe />
      </>,
      { mode: "local" },
    );
    await screen.findByTestId("cache-path");
    const contentReads = () => calls.filter((call) => call.path === "/api/contents/c1").length;
    await waitFor(() => expect(contentReads()).toBe(1));

    fireEvent.click(cacheButtons().change);
    await waitFor(() => expect(cacheShell.pickCacheDir).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();

    // A cancelled pick changed nothing; a picked folder moves at once, without a dialog.
    expect(cacheShell.allowCacheDir).not.toHaveBeenCalled();
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
    fireEvent.click(cacheButtons().change);
    await waitFor(() => expect(order).toEqual(["allow", "put"]));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(cacheShell.allowCacheDir).toHaveBeenCalledWith(PICKED.grant);
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ path: PICKED.path, grant: PICKED.grant });
    expect((await screen.findByTestId("cache-progress")).textContent).toContain("正在迁移");
    expect((cacheButtons().change as HTMLButtonElement).disabled).toBe(true);

    // The next poll finds the move finished: the new path shows and the Content is re-read for its new localPath.
    await waitFor(() => expect(screen.getByTestId("cache-path").textContent).toBe(PICKED.path), { timeout: 3_000 });
    await waitFor(() => expect(contentReads()).toBe(2));
    expect(screen.queryByTestId("cache-progress")).toBeNull();
    expect(cacheButtons().restore).not.toBeNull();
  });

  it("restores the default on click when the source is unavailable, without touching the shell", async () => {
    const { calls } = desktopRoutes({ ...CUSTOM_CACHE, available: false }, {
      "PUT /api/media/cache-location": { status: 202, body: DEFAULT_CACHE },
      "GET /api/contents/c1": { body: contentDetail() },
    });
    renderApp(
      <>
        <StorageSection />
        <ContentProbe />
      </>,
      { mode: "local" },
    );
    await screen.findByTestId("cache-unavailable");
    await waitFor(() => expect(calls.filter((call) => call.path === "/api/contents/c1")).toHaveLength(1));
    // The page already says the old cache is given up while the location is unavailable.
    expect(screen.getByTestId("cache-unavailable").textContent).toContain("旧缓存会被放弃");
    fireEvent.click(cacheButtons().restore as HTMLElement);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ useDefault: true }));
    expect(cacheShell.allowCacheDir).not.toHaveBeenCalled();
    expect(cacheShell.pickCacheDir).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("cache-path").textContent).toBe(DEFAULT_CACHE.path));
    expect(cacheButtons().restore).toBeNull();
    // A switch without a copy still changed every cached path.
    await waitFor(() => expect(calls.filter((call) => call.path === "/api/contents/c1")).toHaveLength(2));
  });

  it("shows the server's refusal inline and keeps the location unchanged", async () => {
    cacheShell.pickCacheDir.mockResolvedValue(PICKED);
    cacheShell.allowCacheDir.mockResolvedValue(undefined);
    desktopRoutes(DEFAULT_CACHE, {
      "PUT /api/media/cache-location": {
        status: 409,
        body: { error: { class: "conflict", code: "conflict.tasks_still_running", retryDisposition: "policy", userMessage: "该用户的任务尚未结束，请稍后重试" } },
      },
    });
    renderApp(<StorageSection />, { mode: "local" });
    await screen.findByTestId("cache-path");
    fireEvent.click(cacheButtons().change);
    const block = screen.getByText("本地缓存").closest("section") as HTMLElement;
    expect((await within(block).findByRole("alert")).textContent).toContain("该用户的任务尚未结束，请稍后重试");
    expect(screen.getByTestId("cache-path").textContent).toBe(DEFAULT_CACHE.path);
    expect((cacheButtons().change as HTMLButtonElement).disabled).toBe(false);
  });

  it("names why the shell refused the picked folder, falling back to a general reason it does not know", async () => {
    cacheShell.pickCacheDir
      .mockRejectedValueOnce("cache_dir:overlaps_data_dir: the cache directory overlaps the data directory")
      .mockRejectedValueOnce("cache_dir:some_future_reason: something new");
    const { calls } = desktopRoutes(DEFAULT_CACHE);
    renderApp(<StorageSection />, { mode: "local" });
    await screen.findByTestId("cache-path");
    const block = screen.getByText("本地缓存").closest("section") as HTMLElement;
    fireEvent.click(cacheButtons().change);
    expect((await within(block).findByRole("alert")).textContent).toContain("所选位置与 Amber 数据目录存在重叠，请选择数据目录之外的文件夹。");
    fireEvent.click(cacheButtons().change);
    await waitFor(() => expect(within(block).getByRole("alert").textContent).toContain("所选文件夹不能用作视频缓存位置，请选择其他文件夹。"));
    expect(cacheShell.allowCacheDir).not.toHaveBeenCalled();
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("shows the sidecar's cache_dir refusal with its own message", async () => {
    cacheShell.pickCacheDir.mockResolvedValue(PICKED);
    cacheShell.allowCacheDir.mockResolvedValue(undefined);
    desktopRoutes(DEFAULT_CACHE, {
      "PUT /api/media/cache-location": {
        status: 400,
        body: {
          error: {
            class: "invalid_request",
            code: "invalid_request.cache_dir",
            retryDisposition: "never",
            userMessage: "所选位置与当前缓存位置存在重叠，请选择与当前缓存位置互不包含的文件夹。",
            details: { reason: "overlaps_current" },
          },
        },
      },
    });
    renderApp(<StorageSection />, { mode: "local" });
    await screen.findByTestId("cache-path");
    fireEvent.click(cacheButtons().change);
    const block = screen.getByText("本地缓存").closest("section") as HTMLElement;
    expect((await within(block).findByRole("alert")).textContent).toContain("所选位置与当前缓存位置存在重叠");
    expect(within(block).getByRole("alert").textContent).not.toContain("请求参数有误");
  });

  it("keeps a shell failure that is not about the cache folder as a general error", async () => {
    cacheShell.pickCacheDir.mockRejectedValue("unusable selection: broken");
    desktopRoutes(DEFAULT_CACHE);
    renderApp(<StorageSection />, { mode: "local" });
    await screen.findByTestId("cache-path");
    fireEvent.click(cacheButtons().change);
    const block = screen.getByText("本地缓存").closest("section") as HTMLElement;
    expect((await within(block).findByRole("alert")).textContent).not.toContain("视频缓存位置");
  });
});

const INSTANCE = {
  concurrencyPipeline: 2,
  maxDataGB: 50,
  lowWaterFreeGB: 5,
  lowWaterFreeRatio: 0.05,
  uploadRetentionDefault: "keep",
  updatedAt: 0,
  envOverridden: [] as string[],
};

/** Local mode outside the desktop client, where the storage section edits the instance parameters. */
function localInstance(settings = INSTANCE, route = "/settings/storage") {
  const api = mockApi({
    "GET /api/version": { body: { version: "0.1.0", mode: "local" } },
    "GET /api/auth/me": { body: { userId: "u1", role: "admin", mode: "local", mustChangePassword: false } },
    "GET /api/usage": { body: { llm: [], asr: [], totals: [] } },
    "GET /api/instance-settings": { body: settings },
    "PATCH /api/instance-settings": (call) => ({ body: { ...settings, ...(call.body as object) } }),
  });
  renderApp(<StorageSection />, { mode: "local", route });
  return api;
}

describe("instance parameters", () => {
  it("splits concurrency from disk and upload, with only the task count capped at its limit", async () => {
    localInstance();
    const block = await screen.findByTestId("instance-concurrency");
    expect(block.id).toBe("concurrency");
    expect(within(block).getByText("任务并发")).toBeTruthy();
    expect(within(block).getByText(/调高后立即允许更多工作开始/u)).toBeTruthy();
    const labels = within(block)
      .getAllByRole("spinbutton")
      .map((input) => block.querySelector(`label[for="${input.id}"]`)?.textContent);
    expect(labels).toEqual(["同时处理的任务数"]);
    const pipeline = screen.getByLabelText("同时处理的任务数") as HTMLInputElement;
    expect([pipeline.type, pipeline.min, pipeline.max, pipeline.step, pipeline.value]).toEqual(["number", "1", String(CONCURRENCY_PIPELINE_MAX), "1", "2"]);
    expect(screen.queryByLabelText("同时进行的模型请求数")).toBeNull();
    expect(screen.queryByLabelText("同时进行的重任务数")).toBeNull();
    expect(
      within(block).getByText(
        `全实例所有任务共用（含缓存、翻译、重新总结等）；超出的排队，按提交顺序开始。模型请求的数量与下载 / 转码等本地处理由系统按模型服务的反馈和任务数自动安排。范围 1–${CONCURRENCY_PIPELINE_MAX}。`,
      ),
    ).toBeTruthy();
    // One setting per row: the long hints never share a row.
    expect(block.querySelector(".sm\\:grid-cols-2")).toBeNull();

    const disk = screen.getByText("磁盘与上传").closest("section") as HTMLElement;
    expect(disk.querySelector(".sm\\:grid-cols-2")).not.toBeNull();
    expect(within(disk).getByLabelText("数据目录上限（GB）")).toBeTruthy();
    expect(within(disk).getByLabelText("上传文件默认保留策略")).toBeTruthy();
    expect(within(disk).queryByRole("spinbutton")).toBeNull();
  });

  it("scrolls to the concurrency block and focuses its first editable input when linked there", async () => {
    const scrolled = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrolled;
    try {
      localInstance(INSTANCE, "/settings/storage#concurrency");
      const block = await screen.findByTestId("instance-concurrency");
      await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("同时处理的任务数")));
      expect(scrolled).toHaveBeenCalledTimes(1);
      expect(scrolled.mock.contexts[0]).toBe(block);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it("still scrolls to a block fixed by the environment but has nothing to focus there", async () => {
    const scrolled = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrolled;
    try {
      localInstance({ ...INSTANCE, envOverridden: ["concurrencyPipeline"] }, "/settings/storage#concurrency");
      const block = await screen.findByTestId("instance-concurrency");
      await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1));
      expect(scrolled.mock.contexts[0]).toBe(block);
      expect(document.activeElement).toBe(document.body);
      // A value set by an environment variable stays read-only and still says so beside its range.
      expect((screen.getByLabelText("同时处理的任务数") as HTMLInputElement).disabled).toBe(true);
      expect(within(block).getByText(/由环境变量设定 · 全实例所有任务共用/u)).toBeTruthy();
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it("does not move focus without the anchor", async () => {
    localInstance();
    await screen.findByTestId("instance-concurrency");
    expect(document.activeElement).toBe(document.body);
  });

  it("refuses a value above the limit or not a whole number, and saves only the changed field of the block", async () => {
    const { calls } = localInstance();
    const block = await screen.findByTestId("instance-concurrency");
    const save = within(block).getByRole("button", { name: "保存" }) as HTMLButtonElement;
    const pipeline = screen.getByLabelText("同时处理的任务数");
    expect(save.disabled).toBe(true);
    fireEvent.change(pipeline, { target: { value: String(CONCURRENCY_PIPELINE_MAX + 1) } });
    expect(save.disabled).toBe(true);
    expect(pipeline.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(pipeline, { target: { value: "0" } });
    expect(save.disabled).toBe(true);
    fireEvent.change(pipeline, { target: { value: "2.5" } });
    expect(save.disabled).toBe(true);
    fireEvent.change(pipeline, { target: { value: String(CONCURRENCY_PIPELINE_MAX) } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ concurrencyPipeline: CONCURRENCY_PIPELINE_MAX }));
    await waitFor(() => expect((screen.getByLabelText("同时处理的任务数") as HTMLInputElement).value).toBe(String(CONCURRENCY_PIPELINE_MAX)));
    expect(save.disabled).toBe(true);
  });
});
