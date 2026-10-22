import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openTargetOf,
  useContentActions,
  type ContentActionOptions,
  type ContentActionSurface,
  type ContentActionTarget,
} from "../../../src/web/components/use-content-actions.tsx";
import type { MenuHit } from "../../../src/web/ui/context-menu.tsx";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";

const PLATFORM: ContentActionTarget = { id: "c1", title: "第一讲", sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" };
const LOCAL: ContentActionTarget = { id: "c2", title: "本地文件" };

/** Lists one menu's rows as buttons ("—" for a separator) next to the shared dialogs. */
function Probe(props: { surface: ContentActionSurface; content: ContentActionTarget; options?: ContentActionOptions }) {
  const actions = useContentActions();
  const location = useLocation();
  return (
    <>
      <ul>
        {actions.entries(props.surface, props.content, props.options).map((entry, index) =>
          entry === "separator" ? (
            <li key={`separator-${index}`}>—</li>
          ) : (
            <li key={entry.id}>
              <button type="button" data-testid={`action-${entry.id}`} onClick={entry.onSelect}>
                {entry.label}
              </button>
            </li>
          ),
        )}
      </ul>
      <p data-testid="where">{`${location.pathname}${location.search}`}</p>
      {actions.dialogs}
    </>
  );
}

const rows = (): string[] => screen.getAllByRole("listitem").map((item) => item.textContent ?? "");

afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>)["clipboard"];
});

describe("useContentActions", () => {
  it("offers open only in the right-click menu, in one shared order with the 「⋯」 menu", () => {
    mockApi({});
    const { unmount } = renderApp(<Probe surface="context" content={PLATFORM} />);
    expect(rows()).toEqual(["打开", "复制来源链接", "—", "重命名", "置顶", "删除", "合集归属"]);
    unmount();
    renderApp(<Probe surface="overflow" content={PLATFORM} />);
    expect(rows()).toEqual(["复制来源链接", "重命名", "置顶", "删除", "合集归属"]);
  });

  it("has no source link for a local file and offers unpin for a pinned Content", () => {
    mockApi({});
    const { unmount } = renderApp(<Probe surface="context" content={{ ...LOCAL, pinnedAt: 5 }} />);
    expect(rows()).toEqual(["打开", "—", "重命名", "取消置顶", "删除", "合集归属"]);
    unmount();
    renderApp(<Probe surface="overflow" content={LOCAL} />);
    expect(rows()).toEqual(["重命名", "置顶", "删除", "合集归属"]);
  });

  it("copies the canonical source URL", async () => {
    mockApi({});
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderApp(<Probe surface="overflow" content={PLATFORM} />);
    fireEvent.click(screen.getByTestId("action-copy-source-url"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PLATFORM.sourceUrl));
  });

  it("opens the Content's page, or the place it was asked to open", () => {
    mockApi({});
    const { unmount } = renderApp(<Probe surface="context" content={PLATFORM} />, { route: "/library" });
    fireEvent.click(screen.getByTestId("action-open"));
    expect(screen.getByTestId("where").textContent).toBe("/contents/c1");
    unmount();
    renderApp(<Probe surface="context" content={PLATFORM} options={{ openTo: "/contents/c1?tab=transcript&segment=s1" }} />, { route: "/library" });
    fireEvent.click(screen.getByTestId("action-open"));
    expect(screen.getByTestId("where").textContent).toBe("/contents/c1?tab=transcript&segment=s1");
  });

  it("pins through the API and opens the shared delete dialog", async () => {
    const { calls } = mockApi({ "PATCH /api/contents/c2": { body: { id: "c2", source: { kind: "local" }, processingStatus: "succeeded", collections: [], createdAt: 1, updatedAt: 1 } } });
    renderApp(<Probe surface="context" content={LOCAL} />);
    fireEvent.click(screen.getByTestId("action-pin"));
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ pinned: true }));
    fireEvent.click(screen.getByTestId("action-delete"));
    const dialog = await screen.findByRole("dialog", { name: "删除这条内容？" });
    expect(dialog.textContent).toContain("本地文件");
  });
});

describe("openTargetOf", () => {
  const hit = (href: string, kind: "internal" | "external"): MenuHit => {
    const element = document.createElement("a");
    return { target: element, anchor: { href, kind, element } };
  };

  it("follows a link into the same Content and nothing else", () => {
    const origin = window.location.origin;
    expect(openTargetOf(hit(`${origin}/contents/c1?tab=transcript&segment=s1#x`, "internal"), "c1")).toBe("/contents/c1?tab=transcript&segment=s1#x");
    expect(openTargetOf(hit(`${origin}/collections/k1`, "internal"), "c1")).toBeUndefined();
    expect(openTargetOf(hit("https://www.youtube.com/watch?v=x", "external"), "c1")).toBeUndefined();
    expect(openTargetOf({ target: document.body }, "c1")).toBeUndefined();
  });
});
