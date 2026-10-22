import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BREAKPOINT_DRAWER_PX } from "../../../../src/shared/defaults.ts";
import { ContentPage } from "../../../../src/web/pages/content/content-page.tsx";
import { ContextMenuHost } from "../../../../src/web/ui/context-menu.tsx";
import { CITED_SEGMENT_ID, contentRoutes, highlightsBody } from "../../../fixtures/web/content-data.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

const PROVIDERS = { body: { items: [{ id: "p1", name: "P", protocol: "openai_compatible", baseURL: "https://x", credentialStatus: "configured", hasCredential: true, models: [], createdAt: 1 }] } };

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: BREAKPOINT_DRAWER_PX + 300 });
  localStorage.clear();
});

describe("HighlightsTab", () => {
  it("shows the items at or above the threshold, with the sentence, and shares the threshold with the player timeline", async () => {
    const { calls } = mockApi({ ...contentRoutes(), "GET /api/contents/c1/highlights": { body: highlightsBody() } });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=ai-highlights", path: "/contents/:id" });
    const list = await screen.findByTestId("highlight-items");
    expect(within(list).getAllByTestId("highlight-item").map((item) => item.getAttribute("data-score"))).toEqual(["92", "80"]);
    expect(list.textContent).toContain("今天讲检索。");
    expect(list.textContent).toContain("开宗明义");
    expect(screen.getByTestId("highlights-timeline").querySelectorAll("[data-highlight]")).toHaveLength(2);
    expect(screen.getByTestId("timeline-highlights").querySelectorAll("[data-highlight]")).toHaveLength(2);

    fireEvent.change(screen.getByTestId("highlights-threshold"), { target: { value: "30" } });
    await waitFor(() => expect(within(screen.getByTestId("highlight-items")).getAllByTestId("highlight-item")).toHaveLength(3));
    expect(screen.getByTestId("timeline-highlights").querySelectorAll("[data-highlight]")).toHaveLength(3);
    fireEvent.change(screen.getByTestId("highlights-threshold"), { target: { value: "95" } });
    await waitFor(() => expect(screen.queryByTestId("highlight-items")).toBeNull());
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("seeks to a highlight when it is clicked", async () => {
    mockApi({ ...contentRoutes(), "GET /api/contents/c1/highlights": { body: highlightsBody() } });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=ai-highlights", path: "/contents/:id" });
    const items = await screen.findAllByTestId("highlight-item");
    fireEvent.click(items[1] as HTMLElement);
    const frame = screen.getByTestId("player-bilibili");
    await waitFor(() => expect(new URL(frame.getAttribute("src") ?? "").searchParams.get("t")).toBe("75"));
  });

  it("generates on the first click without asking again", async () => {
    const { calls } = mockApi({
      ...contentRoutes(),
      "GET /api/providers": PROVIDERS,
      "POST /api/contents/c1/highlights/recompute": { status: 202, body: { taskId: "t9" } },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=ai-highlights", path: "/contents/:id" });
    fireEvent.click(await screen.findByTestId("highlights-generate"));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(calls.find((call) => call.method === "POST")?.path).toBe("/api/contents/c1/highlights/recompute"));
    expect(calls.find((call) => call.method === "POST")?.headers["idempotency-key"]).toBeTruthy();
  });

  it("offers configuration instead of generation without a model, and flags stale highlights", async () => {
    mockApi({ ...contentRoutes(), "GET /api/contents/c1/highlights": { body: highlightsBody({ stale: true, staleReason: "transcript_changed" }) } });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=ai-highlights", path: "/contents/:id" });
    expect(await screen.findByTestId("highlights-stale")).toBeTruthy();
    expect(screen.getByTestId("highlights-configure")).toBeTruthy();
    expect(screen.queryByTestId("highlights-generate")).toBeNull();
  });
});

/** Fires a right click and reports whether the browser menu was prevented. */
function rightClick(element: Element): boolean {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  act(() => {
    element.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

function stubClipboard() {
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return writeText;
}

describe("HighlightsTab context menu", () => {
  it("copies and explains the highlighted sentence, not the model's reason, and plays from it", async () => {
    const writeText = stubClipboard();
    const { calls } = mockApi({ ...contentRoutes(), "GET /api/contents/c1/highlights": { body: highlightsBody() } });
    renderApp(
      <ContextMenuHost blockNative={false}>
        <ContentPage />
      </ContextMenuHost>,
      { route: "/contents/c1?tab=ai-highlights", path: "/contents/:id" },
    );
    const list = await screen.findByTestId("highlight-items");
    expect(list.getAttribute("data-revision-id")).toBe("r1");
    const item = list.querySelector(`[data-segment-id='${CITED_SEGMENT_ID}']`) as HTMLElement;
    expect(item.textContent).toContain("关键方法");
    expect(rightClick(within(item).getByText("关键方法"))).toBe(true);
    expect(screen.getAllByRole("menuitem").map((entry) => entry.textContent)).toEqual(["从这里播放", "复制这句", "复制这句（带时间）", "解释这句"]);
    fireEvent.click(screen.getByTestId("context-menu-item-copy-sentence"));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("再看重排序。"));
    rightClick(item);
    fireEvent.click(screen.getByTestId("context-menu-item-copy-sentence-with-time"));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("[1:15] 再看重排序。"));
    rightClick(item);
    fireEvent.click(screen.getByTestId("context-menu-item-explain-sentence"));
    await waitFor(() => expect((screen.getByTestId("chat-input") as HTMLTextAreaElement).value).toBe("解释一下这句话"));
    expect(screen.getByTestId("chat-quote").textContent).toBe("再看重排序。");
    rightClick(item);
    fireEvent.click(screen.getByTestId("context-menu-item-play-from-here"));
    await waitFor(() => expect(new URL(screen.getByTestId("player-bilibili").getAttribute("src") ?? "").searchParams.get("t")).toBe("75"));
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("leaves the space around the items to the browser", async () => {
    mockApi({ ...contentRoutes(), "GET /api/contents/c1/highlights": { body: highlightsBody() } });
    renderApp(
      <ContextMenuHost blockNative={false}>
        <ContentPage />
      </ContextMenuHost>,
      { route: "/contents/c1?tab=ai-highlights", path: "/contents/:id" },
    );
    expect(rightClick(await screen.findByTestId("highlight-items"))).toBe(false);
  });
});
