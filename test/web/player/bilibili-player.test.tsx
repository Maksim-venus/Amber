import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BilibiliPlayer } from "../../../src/web/player/bilibili-player.tsx";
import { PlayerController, PlayerControllerProvider } from "../../../src/web/player/player-controller.tsx";

describe("BilibiliPlayer", () => {
  it("reloads the iframe with t= on seek and shows a loading state until it loads", () => {
    const controller = new PlayerController();
    render(
      <PlayerControllerProvider controller={controller}>
        <BilibiliPlayer source={{ kind: "bilibili", bvid: "BV1" }} />
      </PlayerControllerProvider>,
    );
    const frame = screen.getByTestId("player-bilibili");
    fireEvent.load(frame);
    expect(screen.queryByTestId("player-loading")).toBeNull();
    act(() => controller.seek(90_000));
    expect(new URL(frame.getAttribute("src") ?? "").searchParams.get("t")).toBe("90");
    expect(screen.getByTestId("player-loading")).toBeTruthy();
    expect(controller.capabilities.timeTracking).toBe("unsupported");
  });
});
