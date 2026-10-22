import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDragOrder } from "../../../src/web/ui/use-drag-order.ts";

function List(props: { ids: string[]; onCommit: (order: string[]) => void }) {
  const { order, rowRef, handleProps } = useDragOrder(props.ids, props.onCommit);
  return (
    <ul>
      {order.map((id, index) => (
        <li
          key={id}
          ref={(element) => {
            rowRef(id)(element);
            // jsdom lays nothing out: rows are 20 px tall, stacked from the top.
            if (element !== null) element.getBoundingClientRect = () => ({ top: index * 20, height: 20 }) as DOMRect;
          }}
          data-testid="row"
        >
          <button type="button" aria-label={`move ${id}`} {...handleProps(id)} />
          {id}
        </li>
      ))}
    </ul>
  );
}

describe("useDragOrder", () => {
  it("moves a dragged row under the pointer and commits the whole order only on release", () => {
    HTMLElement.prototype.setPointerCapture = vi.fn();
    const onCommit = vi.fn();
    render(<List ids={["a", "b", "c"]} onCommit={onCommit} />);
    const handle = screen.getByRole("button", { name: "move a" });
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 5 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 45 });
    expect(screen.getAllByTestId("row").map((row) => row.textContent)).toEqual(["b", "c", "a"]);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(onCommit).toHaveBeenCalledWith(["b", "c", "a"]);
  });

  it("moves with the arrow keys and leaves an unchanged order uncommitted", () => {
    const onCommit = vi.fn();
    render(<List ids={["a", "b", "c"]} onCommit={onCommit} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "move a" }), { key: "ArrowUp" });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("button", { name: "move c" }), { key: "ArrowUp" });
    expect(onCommit).toHaveBeenCalledWith(["a", "c", "b"]);
    fireEvent.keyDown(screen.getByRole("button", { name: "move a" }), { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});

describe("useDragOrder with other buttons", () => {
  it("does not start a drag on a right click", () => {
    const capture = vi.fn();
    HTMLElement.prototype.setPointerCapture = capture;
    const onCommit = vi.fn();
    render(<List ids={["a", "b"]} onCommit={onCommit} />);
    const handle = screen.getByRole("button", { name: "move a" });
    fireEvent.pointerDown(handle, { pointerId: 1, button: 2, clientY: 5 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 30 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(capture).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("row").map((row) => row.textContent)).toEqual(["a", "b"]);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
