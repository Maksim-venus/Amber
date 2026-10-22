import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useVolumeSetting, VolumeControl } from "../../../src/web/player/volume-control.tsx";

function Harness() {
  const setting = useVolumeSetting();
  return (
    <>
      <VolumeControl setting={setting} />
      <output data-testid="state">{`${setting.volume}|${setting.muted ? "muted" : "on"}`}</output>
    </>
  );
}

beforeEach(() => localStorage.clear());

describe("VolumeControl", () => {
  it("starts at full volume, unmuted, when nothing is stored or the value is unreadable", () => {
    localStorage.setItem("amber.player.volume", "loud");
    render(<Harness />);
    expect(screen.getByTestId("state").textContent).toBe("1|on");
    expect(screen.getByTestId("player-volume-percent").textContent).toBe("100");
    expect(screen.getByRole("button", { name: "静音" })).toBeTruthy();
  });

  it("toggles mute from the speaker button and stores it", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("player-mute"));
    expect(screen.getByTestId("state").textContent).toBe("1|muted");
    expect(localStorage.getItem("amber.player.muted")).toBe("1");
    expect(screen.getByTestId("player-volume-percent").textContent).toBe("0");
    expect((screen.getByTestId("player-volume-range") as HTMLInputElement).value).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "取消静音" }));
    expect(localStorage.getItem("amber.player.muted")).toBe("0");
  });

  it("sets the level from the slider in percent, clamps it and lifts mute above zero", () => {
    localStorage.setItem("amber.player.muted", "1");
    render(<Harness />);
    fireEvent.change(screen.getByTestId("player-volume-range"), { target: { value: "35" } });
    expect(screen.getByTestId("state").textContent).toBe("0.35|on");
    expect(localStorage.getItem("amber.player.volume")).toBe("0.35");
    // The level paints the slider's filled part.
    expect(screen.getByTestId("player-volume-range").style.getPropertyValue("--volume-fill")).toBe("35%");
    fireEvent.change(screen.getByTestId("player-volume-range"), { target: { value: "0" } });
    expect(screen.getByTestId("state").textContent).toBe("0|on");
  });

  it("keeps the slider in a popover above the button, inside the control itself", () => {
    render(<Harness />);
    const control = screen.getByTestId("player-volume");
    const popover = screen.getByTestId("player-volume-popover");
    expect(control.contains(popover)).toBe(true);
    expect(popover.className).toContain("bottom-full");
    expect(popover.className).toContain("group-hover:flex");
    expect(popover.className).toContain("group-focus-within:flex");
    expect(screen.getByTestId("player-volume-range").getAttribute("aria-label")).toBe("音量");
  });
});
