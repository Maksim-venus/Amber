import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarWidthProvider, useMainWidth, useReportSidebarWidth, useWindowWidth } from "../../src/web/layout-width.tsx";

let fullscreen: Element | null = null;

function setWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

/** Lets the deferred resize handling run. */
function settle(): void {
  act(() => vi.runOnlyPendingTimers());
}

function Widths() {
  return (
    <p data-testid="widths">
      {useWindowWidth()}|{useMainWidth()}
    </p>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  fullscreen = null;
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreen });
  setWidth(1200);
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, "fullscreenElement");
});

describe("useWindowWidth", () => {
  it("follows window resizes", () => {
    render(<Widths />);
    expect(screen.getByTestId("widths").textContent).toBe("1200|1200");
    setWidth(900);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    settle();
    expect(screen.getByTestId("widths").textContent).toBe("900|900");
  });

  it("holds still while something is fullscreen, so the layout does not switch and remount the player", () => {
    render(<Widths />);
    // The resize that enters fullscreen may come before the fullscreen element is set.
    setWidth(1920);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    fullscreen = document.body;
    act(() => {
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    settle();
    expect(screen.getByTestId("widths").textContent).toBe("1200|1200");
    // A render for any other reason during fullscreen still reads the frozen width.
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    settle();
    expect(screen.getByTestId("widths").textContent).toBe("1200|1200");

    // Leaving fullscreen reads the window again.
    fullscreen = null;
    setWidth(1000);
    act(() => {
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    settle();
    expect(screen.getByTestId("widths").textContent).toBe("1000|1000");
  });

  it("subtracts the reported sidebar width for the main area", () => {
    function Sidebar() {
      const report = useReportSidebarWidth();
      return (
        <button type="button" onClick={() => report(240)}>
          report
        </button>
      );
    }
    render(
      <SidebarWidthProvider>
        <Sidebar />
        <Widths />
      </SidebarWidthProvider>,
    );
    act(() => screen.getByRole("button").click());
    expect(screen.getByTestId("widths").textContent).toBe("1200|960");
  });
});
