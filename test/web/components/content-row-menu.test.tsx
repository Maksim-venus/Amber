import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContentRowMenu } from "../../../src/web/components/content-row-menu.tsx";
import { useContentActions, type ContentActionTarget } from "../../../src/web/components/use-content-actions.tsx";
import { collection, content } from "../../fixtures/web/shell-data.ts";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";

/** A row as the lists build it: the hook, the 「⋯」 menu and the dialogs rendered once. */
function Row(props: { content: ContentActionTarget }) {
  const actions = useContentActions();
  return (
    <div className="group">
      <ContentRowMenu actions={actions} content={props.content} label={props.content.title ?? ""} />
      {actions.dialogs}
    </div>
  );
}

const openMenu = async (title: string): Promise<string[]> => {
  fireEvent.keyDown(screen.getByRole("button", { name: `「${title}」的更多操作` }), { key: "Enter" });
  return within(await screen.findByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent ?? "");
};

describe("ContentRowMenu", () => {
  it("lists the 「⋯」 actions, the source link first for platform content, and never open", async () => {
    mockApi({});
    renderApp(<Row content={{ id: "c1", title: "第一讲", sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }} />);
    expect(await openMenu("第一讲")).toEqual(["复制来源链接", "重命名", "置顶", "删除", "合集归属"]);
  });

  it("has no source link for a local file and opens the row's shared dialog", async () => {
    mockApi({
      "GET /api/contents/c2": { body: { ...content("c2", { title: "本地文件", source: { kind: "local" } }), media: [] } },
      "GET /api/collections": { body: { items: [collection("k1", "Test")] } },
    });
    renderApp(<Row content={{ id: "c2", title: "本地文件" }} />);
    expect(await openMenu("本地文件")).toEqual(["重命名", "置顶", "删除", "合集归属"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "合集归属" }));
    const dialog = await screen.findByRole("dialog", { name: "管理合集" });
    await waitFor(() => expect(within(dialog).getByRole("checkbox", { name: "Test" })).toBeTruthy());
  });
});
