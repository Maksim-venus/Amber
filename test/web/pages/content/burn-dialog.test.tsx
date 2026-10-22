import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentDetailDto, MediaAssetDto, TranscriptRevisionDto } from "../../../../src/shared/dto/content.ts";
import { defaultSubtitleAppearance, defaultSubtitlePlacement } from "../../../../src/shared/subtitle-style.ts";
import { ApiError } from "../../../../src/web/api/client.ts";
import {
  BurnDialog,
  burnDefaults,
  burnRequest,
  burnSources,
  burnSourceVideo,
  unsupportedStreams,
  videoFormat,
} from "../../../../src/web/pages/content/burn-dialog.tsx";
import { ContentPageProvider, type ContentPageState } from "../../../../src/web/pages/content/content-context.tsx";
import { resetSubtitlePrefsMemory, writeAppearance, writePlacement, writeTrack } from "../../../../src/web/player/subtitle-prefs.ts";
import { contentDetail, revision } from "../../../fixtures/web/content-data.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

const original = revision("r1");
const proofread = revision("r2", { kind: "asr" });
const english = revision("t1", { kind: "translated", language: "en", parentRevisionId: "r1" });
const japanese = revision("t2", { kind: "translated", language: "ja", parentRevisionId: "r1" });
const other = revision("t9", { kind: "translated", language: "ja", parentRevisionId: "r0" });
const STYLE = { appearance: defaultSubtitleAppearance(), placement: defaultSubtitlePlacement() };

function asset(id: string, overrides: Partial<MediaAssetDto>): MediaAssetDto {
  return { id, kind: "platform_cache", mimeType: "video/mp4", sizeBytes: 1, availability: "available", retentionPolicy: "evictable", createdAt: 1, ...overrides };
}

beforeEach(() => {
  localStorage.clear();
  resetSubtitlePrefsMemory();
});

describe("burn sources", () => {
  const all = [original, english, other];

  it("exports a translation over its parent and offers only the original's translations", () => {
    expect(burnSources(english, all)).toEqual({ original, translations: [english] });
    expect(burnSources(original, all)).toEqual({ original, translations: [english] });
  });

  it("always sends the full output choice and names the translation only for the translation modes", () => {
    const soft = { delivery: "soft", container: "mkv", style: STYLE } as const;
    expect(burnRequest(original, "original", "t1", soft)).toEqual({ revisionId: "r1", mode: "original", delivery: "soft", container: "mkv", style: STYLE });
    expect(burnRequest(original, "translation", "t1", soft)).toEqual({
      revisionId: "r1",
      translationRevisionId: "t1",
      mode: "translation",
      delivery: "soft",
      container: "mkv",
      style: STYLE,
    });
    expect(burnRequest(original, "bilingual", undefined, soft)).toBeUndefined();
    // A hard-subtitle export is MP4 whatever container was last picked for soft subtitles.
    expect(burnRequest(original, "original", undefined, { ...soft, delivery: "hard" })?.container).toBe("mp4");
  });

  it("starts from what the player shows, else from the version open in the tab", () => {
    const all2 = [original, proofread, english, japanese];
    const off = { version: 1, mode: "off" } as const;
    expect(burnDefaults(original, all2, "r1", off)).toEqual({ originalId: "r1", mode: "original", translationId: "t1" });
    expect(burnDefaults(japanese, all2, "r1", off)).toEqual({ originalId: "r1", mode: "bilingual", translationId: "t2" });
    expect(burnDefaults(proofread, all2, "r1", { version: 1, mode: "translation", translationRevisionId: "t2" })).toEqual({
      originalId: "r1",
      mode: "translation",
      translationId: "t2",
    });
    // The player's original without translations falls back to the original only.
    expect(burnDefaults(original, all2, "r1", { version: 1, mode: "bilingual", revisionId: "r2" })).toEqual({ originalId: "r2", mode: "original", translationId: undefined });
    // A version the player remembers that no longer exists is ignored.
    expect(burnDefaults(original, all2, "r1", { version: 1, mode: "bilingual", revisionId: "gone" })).toEqual({ originalId: "r1", mode: "original", translationId: "t1" });
  });

  it("picks the source video the way the server does", () => {
    const upload = asset("up", { kind: "managed_upload", displayName: "lecture.MKV", mimeType: "video/x-matroska", createdAt: 5 });
    const cacheOld = asset("c-old", { createdAt: 2 });
    const cacheNew = asset("c-new", { createdAt: 3, mimeType: "video/webm" });
    const audio = asset("aud", { mimeType: "audio/mpeg", createdAt: 9 });
    expect(burnSourceVideo([cacheOld, upload, cacheNew])).toEqual({ asset: upload, kind: "original" });
    expect(burnSourceVideo([cacheOld, cacheNew, audio])).toEqual({ asset: cacheNew, kind: "cache" });
    expect(burnSourceVideo([{ ...upload, availability: "missing" }, cacheOld])).toEqual({ asset: cacheOld, kind: "cache" });
    expect(burnSourceVideo([audio])).toBeUndefined();
    expect(videoFormat(upload)).toBe("MKV");
    expect(videoFormat(cacheNew)).toBe("WEBM");
    expect(videoFormat({ mimeType: "video/x-matroska" })).toBe("MKV");
    expect(videoFormat({ mimeType: "video/mp4", localPath: "D:\\Videos\\talk.mov" })).toBe("MOV");
  });

  it("reads the incompatible streams of an MP4 refusal", () => {
    const refusal = new ApiError(400, {
      class: "invalid_request",
      code: "invalid_request.container_unsupported",
      retryDisposition: "never",
      userMessage: "",
      details: { streams: ["0:video:vp9", "1:audio:opus", "odd"] },
    });
    expect(unsupportedStreams(refusal)).toEqual(["#0 video vp9", "#1 audio opus", "odd"]);
    expect(unsupportedStreams(new ApiError(400, { class: "invalid_request", code: "invalid_request", retryDisposition: "never", userMessage: "" }))).toBeUndefined();
    expect(unsupportedStreams(new Error("x"))).toBeUndefined();
  });
});

describe("BurnDialog", () => {
  const ME = { body: { userId: "u1", role: "admin", mode: "local", mustChangePassword: false } };
  const SOURCE = asset("a1", { kind: "external_local", localPath: "D:\\Videos\\第一讲.mp4", sizeBytes: 3 * 1024 * 1024 });

  function renderDialog(options: { media?: MediaAssetDto[]; revisions?: TranscriptRevisionDto[]; burn?: Parameters<typeof mockApi>[0][string] } = {}) {
    const api = mockApi({ "GET /api/auth/me": ME, "POST /api/contents/c1/burn": options.burn ?? { status: 202, body: { taskId: "t7" } } });
    const page: ContentPageState = {
      content: contentDetail({ media: options.media ?? [SOURCE] }) as ContentDetailDto,
      primaryRevisionId: "r1",
      selection: undefined,
      select: vi.fn(),
      openTab: vi.fn(),
      highlightThreshold: 0,
      setHighlightThreshold: vi.fn(),
      openSubtitleEditor: vi.fn(),
    };
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const onStarted = vi.fn<(taskId: string) => void>();
    const { unmount } = renderApp(
      <ContentPageProvider value={page}>
        <BurnDialog
          contentId="c1"
          selected={original}
          revisions={options.revisions ?? [original, english, japanese]}
          primaryId="r1"
          open
          onOpenChange={onOpenChange}
          onStarted={onStarted}
        />
      </ContentPageProvider>,
    );
    return { ...api, page, onOpenChange, onStarted, unmount, dialog: screen.getByRole("dialog", { name: "导出字幕视频" }) };
  }

  async function startEnabled(dialog: HTMLElement) {
    const start = within(dialog).getByTestId("burn-start") as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    return start;
  }

  it("starts from the player's subtitles and sends its full style", async () => {
    const appearance = { ...defaultSubtitleAppearance(), translation: { fontSize: 40, color: "#00FFAA" } };
    const placement = { version: 1, xBp: 5000, yBp: 500, anchor: "top" } as const;
    writeAppearance("u1", appearance);
    writePlacement("u1", "c1", placement);
    writeTrack("u1", "c1", { version: 1, mode: "translation", translationRevisionId: "t2" });
    const { dialog, calls, onStarted } = renderDialog();
    await waitFor(() => expect((within(dialog).getByLabelText("仅译文") as HTMLInputElement).checked).toBe(true));
    expect((within(dialog).getByTestId("burn-translation") as HTMLSelectElement).value).toBe("t2");
    expect((within(dialog).getByTestId("burn-original") as HTMLSelectElement).value).toBe("r1");
    expect(within(dialog).getByTestId("burn-source-video").textContent).toBe("源视频：原文件 · MP4");
    expect(within(dialog).getByTestId("burn-style-summary").textContent).toContain("译文 40 号");
    fireEvent.click(await startEnabled(dialog));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("t7"));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      revisionId: "r1",
      translationRevisionId: "t2",
      mode: "translation",
      delivery: "hard",
      container: "mp4",
      style: { appearance, placement },
    });
  });

  it("asks for a container only for soft subtitles, MKV first", async () => {
    const { dialog, calls } = renderDialog();
    expect(within(dialog).queryByTestId("burn-container")).toBeNull();
    expect(within(dialog).getByTestId("burn-estimated-size").textContent).toBe("预计大小：与源文件同一量级");
    fireEvent.click(within(dialog).getByLabelText("软字幕轨", { exact: false }));
    const container = within(dialog).getByTestId("burn-container");
    expect((within(container).getByLabelText("MKV（推荐）", { exact: false }) as HTMLInputElement).checked).toBe(true);
    expect(within(dialog).getByTestId("burn-estimated-size").textContent).toBe("预计大小：约 3.0 MB");
    fireEvent.click(within(container).getByLabelText("MP4", { exact: false }));
    fireEvent.click(await startEnabled(dialog));
    await waitFor(() => expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({ mode: "original", delivery: "soft", container: "mp4", style: STYLE }));
  });

  it("lists the streams MP4 cannot hold and switches to MKV in one click", async () => {
    let attempts = 0;
    const { dialog, calls, onStarted } = renderDialog({
      burn: () => {
        attempts += 1;
        return attempts === 1
          ? {
              status: 400,
              body: {
                error: {
                  class: "invalid_request",
                  code: "invalid_request.container_unsupported",
                  retryDisposition: "never",
                  userMessage: "",
                  details: { streams: ["0:video:vp9", "1:audio:opus"] },
                },
              },
            }
          : { status: 202, body: { taskId: "t8" } };
      },
    });
    fireEvent.click(within(dialog).getByLabelText("软字幕轨", { exact: false }));
    fireEvent.click(within(within(dialog).getByTestId("burn-container")).getByLabelText("MP4", { exact: false }));
    fireEvent.click(await startEnabled(dialog));
    const alert = await within(dialog).findByTestId("burn-unsupported");
    expect(alert.textContent).toContain("MP4 无法容纳源视频中的这些流：#0 video vp9和#1 audio opus。请改用 MKV。");
    fireEvent.click(within(alert).getByTestId("burn-use-mkv"));
    expect(within(dialog).queryByTestId("burn-unsupported")).toBeNull();
    expect((within(within(dialog).getByTestId("burn-container")).getByLabelText("MKV（推荐）", { exact: false }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(await startEnabled(dialog));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("t8"));
    expect(calls.filter((call) => call.method === "POST").map((call) => (call.body as { container: string }).container)).toEqual(["mp4", "mkv"]);
  });

  it("hands style editing to the player and closes", async () => {
    const { dialog, page, onOpenChange } = renderDialog();
    fireEvent.click(within(dialog).getByTestId("burn-adjust-style"));
    expect(page.openSubtitleEditor).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("names a cache source and cannot start without a video", async () => {
    const first = renderDialog({ media: [asset("c1", { displayName: "第一讲.webm", mimeType: "video/webm" })] });
    expect(within(first.dialog).getByTestId("burn-source-video").textContent).toBe("源视频：本地缓存 · WEBM");
    await startEnabled(first.dialog);
    first.unmount();
    const second = renderDialog({ media: [asset("aud", { mimeType: "audio/mpeg" })] });
    expect(within(second.dialog).getByTestId("burn-source-video").textContent).toBe("没有可用的视频：请先缓存视频，或重新关联原文件。");
    expect((within(second.dialog).getByTestId("burn-start") as HTMLButtonElement).disabled).toBe(true);
  });
});
