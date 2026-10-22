import { act, fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectionItemDto } from "../../../../src/shared/dto/collection.ts";
import { useContentActions } from "../../../../src/web/components/use-content-actions.tsx";
import { ItemList, ReorderList } from "../../../../src/web/pages/collection/item-list.tsx";
import { ContextMenuHost } from "../../../../src/web/ui/context-menu.tsx";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

const ITEMS: CollectionItemDto[] = [
  { id: "i1", contentId: "c1", position: 0, addedAt: 1, title: "第一讲", processingStatus: "succeeded", sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
  { id: "i2", contentId: "c2", position: 1, addedAt: 1, title: "第二讲", processingStatus: "succeeded" },
];

function rightClick(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
}

function contextLabels(): (string | null)[] {
  return within(screen.getByTestId("context-menu")).getAllByRole("menuitem").map((item) => item.textContent);
}

function List(props: { startIndex?: number }) {
  const actions = useContentActions();
  return (
    <>
      <ItemList items={ITEMS} startIndex={props.startIndex ?? 0} actions={actions} />
      {actions.dialogs}
    </>
  );
}

/** The draft lives in the parent, as on the collection page; `onChange` records each draft. */
function Draft(props: { onChange: (order: string[]) => void }) {
  const actions = useContentActions();
  const [order, setOrder] = useState(() => ITEMS.map((item) => item.id));
  return (
    <>
      <ReorderList
        items={ITEMS}
        order={order}
        onChange={(next) => {
          props.onChange(next);
          setOrder(next);
        }}
        actions={actions}
      />
      {actions.dialogs}
    </>
  );
}

function renderList(startIndex?: number) {
  mockApi({});
  renderApp(
    <ContextMenuHost blockNative={false}>
      <List {...(startIndex === undefined ? {} : { startIndex })} />
    </ContextMenuHost>,
  );
}

function renderDraft(onChange = vi.fn()) {
  mockApi({});
  renderApp(
    <ContextMenuHost blockNative={false}>
      <Draft onChange={onChange} />
    </ContextMenuHost>,
  );
  return { onChange };
}

const numbers = () => screen.getAllByTestId("collection-item").map((row) => within(row).getByText(/^第 \d+ 讲$/).textContent);

const original = HTMLElement.prototype.setPointerCapture;
afterEach(() => {
  HTMLElement.prototype.setPointerCapture = original;
});

describe("ItemList", () => {
  it("offers the Content's actions on a right click and leaves removal to 「合集归属」", () => {
    renderList();
    const [first, second] = screen.getAllByTestId("collection-item");
    rightClick(within(first as HTMLElement).getByText("第 1 讲"));
    expect(contextLabels()).toEqual(["打开", "在新标签页中打开", "复制来源链接", "重命名", "置顶", "删除", "合集归属"]);
    act(() => {
      fireEvent.keyDown(screen.getByTestId("context-menu"), { key: "Escape" });
    });
    rightClick(within(second as HTMLElement).getByText("第二讲"));
    expect(contextLabels()).toEqual(["在新标签页中打开", "复制链接地址", "打开", "重命名", "置顶", "删除", "合集归属"]);
  });

  it("numbers the rows by their place in the whole collection and has no buttons on a row", () => {
    renderList(10);
    expect(numbers()).toEqual(["第 11 讲", "第 12 讲"]);
    expect(screen.queryByRole("button", { name: /移出合集/ })).toBeNull();
    for (const row of screen.getAllByTestId("collection-item")) {
      expect(within(row).queryAllByRole("button")).toEqual([]);
    }
  });
});

describe("ReorderList", () => {
  it("hands each keyboard move's complete draft to its parent", () => {
    const { onChange } = renderDraft();
    expect(numbers()).toEqual(["第 1 讲", "第 2 讲"]);
    fireEvent.keyDown(screen.getByRole("button", { name: "拖动排序 · 第一讲" }), { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith(["i2", "i1"]);
    expect(screen.getAllByTestId("collection-item").map((row) => row.dataset["itemId"])).toEqual(["i2", "i1"]);
    // Rows are numbered by their place in the draft.
    expect(within(screen.getAllByTestId("collection-item")[0] as HTMLElement).getByText("第 1 讲")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("button", { name: "拖动排序 · 第一讲" }), { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith(["i1", "i2"]);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("does not report a move past either end", () => {
    const { onChange } = renderDraft();
    fireEvent.keyDown(screen.getByRole("button", { name: "拖动排序 · 第一讲" }), { key: "ArrowUp" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("opens the menu from the drag handle without starting a drag", () => {
    const capture = vi.fn();
    HTMLElement.prototype.setPointerCapture = capture;
    const { onChange } = renderDraft();
    const handle = screen.getByRole("button", { name: "拖动排序 · 第一讲" });
    fireEvent.pointerDown(handle, { pointerId: 1, button: 2, clientY: 5 });
    rightClick(handle);
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 300 });
    expect(capture).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("collection-item")[0]?.className).not.toContain("bg-accent-soft");
    expect(screen.getByTestId("context-menu-item-open")).toBeTruthy();
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });
});
