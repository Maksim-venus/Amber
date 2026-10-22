import { act, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, onTestFinished } from "vitest";
import { VirtualRows, type VirtualRowsHandle } from "../../../../src/web/pages/content/virtual-rows.tsx";

function renderRows(count: number) {
  const handle = createRef<VirtualRowsHandle>();
  const items = Array.from({ length: count }, (_, index) => `row ${index}`);
  render(<VirtualRows ref={handle} items={items} keyOf={(item) => item} render={(item) => <p>{item}</p>} estimateSize={40} testId="rows" />);
  return { handle, list: screen.getByTestId("rows") };
}

describe("VirtualRows handle", () => {
  it("scrolls a short list to its top, its bottom and a row placed at the top", () => {
    const { handle, list } = renderRows(10);
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 900 });
    act(() => handle.current?.scrollToBottom());
    expect(list.scrollTop).toBe(900);
    act(() => handle.current?.scrollToTop());
    expect(list.scrollTop).toBe(0);
    const row = list.querySelector('[data-row-index="4"]') as HTMLElement;
    list.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 100, width: 300, height: 400 });
    row.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 260, width: 300, height: 40 });
    act(() => handle.current?.scrollToIndex(4, "start"));
    expect(list.scrollTop).toBe(160);
  });

  it("centres a row with scrollIntoView by default and ignores rows that are not there", () => {
    const { handle, list } = renderRows(10);
    const row = list.querySelector('[data-row-index="2"]') as HTMLElement;
    const calls: unknown[] = [];
    row.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => {
      calls.push(options);
    };
    act(() => handle.current?.scrollToIndex(2));
    expect(calls).toEqual([{ block: "center" }]);
    act(() => handle.current?.scrollToIndex(99, "start"));
    expect(list.scrollTop).toBe(0);
  });

  it("drives a windowed list through the virtualizer without throwing", () => {
    const { handle } = renderRows(200);
    expect(() =>
      act(() => {
        handle.current?.scrollToIndex(120, "start");
        handle.current?.scrollToIndex(60);
        handle.current?.scrollToBottom();
        handle.current?.scrollToTop();
      }),
    ).not.toThrow();
  });
});

describe("VirtualRows pinned row", () => {
  it("keeps the pinned row mounted outside the window and drops it once unpinned", () => {
    // jsdom has no layout: give every element a height so the virtualizer computes a window.
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 400 });
    onTestFinished(() => {
      if (original !== undefined) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
    });
    const items = Array.from({ length: 300 }, (_, index) => `row ${index}`);
    const view = (pinnedIndex: number | undefined) => (
      <VirtualRows items={items} keyOf={(item) => item} render={(item) => <p>{item}</p>} estimateSize={40} testId="rows" pinnedIndex={pinnedIndex} />
    );
    const { rerender } = render(view(250));
    const list = screen.getByTestId("rows");
    expect(list.querySelector('[data-row-index="0"]')).not.toBeNull();
    expect(list.querySelector('[data-row-index="100"]')).toBeNull();
    expect(list.querySelector('[data-row-index="250"]')).not.toBeNull();
    rerender(view(undefined));
    expect(list.querySelector('[data-row-index="250"]')).toBeNull();
  });
});
