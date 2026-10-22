import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDesktop } from "../../../src/web/desktop/use-desktop.ts";
import { fakeShell } from "../../fixtures/web/desktop-bridge.ts";
import { renderApp } from "../../fixtures/web/render.tsx";

vi.mock("../../../src/web/desktop/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("../../fixtures/web/desktop-bridge.ts")).fakeBridge,
}));

function Probe() {
  return <p data-testid="desktop">{String(useDesktop())}</p>;
}

describe("useDesktop", () => {
  it("is true for a local backend inside the desktop shell", async () => {
    fakeShell.desktop = true;
    renderApp(<Probe />, { mode: "local" });
    await waitFor(() => expect(screen.getByTestId("desktop").textContent).toBe("true"));
  });

  it("is false for a local backend in a plain browser and always in server mode", async () => {
    renderApp(<Probe />, { mode: "local" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByTestId("desktop").textContent).toBe("false");
    fakeShell.desktop = true;
    renderApp(<Probe />, { mode: "server" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getAllByTestId("desktop").map((node) => node.textContent)).toEqual(["false", "false"]);
  });
});
