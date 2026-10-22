import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Splitter } from "../../../src/web/ui/splitter.tsx";

describe("Splitter", () => {
  it("reports each pointer move as a delta, ends on release and asks for the default on double click", () => {
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    const onResize = vi.fn();
    const onEnd = vi.fn();
    const onReset = vi.fn();
    render(<Splitter label="调整栏宽" onResize={onResize} onEnd={onEnd} onReset={onReset} testId="s" />);
    const handle = screen.getByRole("separator", { name: "调整栏宽" });
    // A move without a press does nothing.
    fireEvent.pointerMove(handle, { clientX: 120, pointerId: 1 });
    expect(onResize).not.toHaveBeenCalled();
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 130, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 120, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 120, pointerId: 1 });
    expect(onResize.mock.calls).toEqual([[30], [-10]]);
    expect(onEnd).toHaveBeenCalledTimes(1);
    fireEvent.doubleClick(handle);
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
