import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLAYER_CONTROLS_IDLE_MS, PLAYER_SEEK_TOLERANCE_MS, PLAYER_SKIP_SECONDS, PLAYER_VOLUME_STEP } from "../../../src/shared/defaults.ts";
import type { AdvanceResult } from "../../../src/web/player/list-loop.ts";
import { LocalPlayer } from "../../../src/web/player/local-player.tsx";
import { PlayerController, PlayerControllerProvider } from "../../../src/web/player/player-controller.tsx";
import type { EndBehavior, PlayerSettings } from "../../../src/web/player/player-settings.ts";

const settings = vi.hoisted(() => ({ endBehavior: "pause" as EndBehavior, autoplay: false }));

vi.mock("../../../src/web/player/player-settings.ts", () => ({
  END_BEHAVIORS: ["pause", "loop_one", "loop_list"],
  usePlayerSettings: (): PlayerSettings => ({ ...settings, setEndBehavior: () => undefined, setAutoplay: () => undefined }),
}));

// Stand-ins for the menus: a trigger that opens / closes and picks a rate, recording where the popup would go.
const menus = vi.hoisted(() => ({ containers: [] as Array<HTMLElement | null> }));
vi.mock("../../../src/web/player/player-menus.tsx", () => ({
  PLAYBACK_RATES: [2, 1.5, 1.25, 1, 0.75, 0.5],
  PlaybackRateMenu: (props: { rate: number; onRate: (rate: number) => void; container: HTMLElement | null; onOpenChange?: (open: boolean) => void }) => {
    menus.containers.push(props.container);
    return (
      <>
        <button type="button" data-testid="rate-menu" onClick={() => props.onRate(1.5)}>
          {`${props.rate}×`}
        </button>
        <button type="button" data-testid="rate-menu-open" onClick={() => props.onOpenChange?.(true)} />
        <button type="button" data-testid="rate-menu-close" onClick={() => props.onOpenChange?.(false)} />
      </>
    );
  },
  PlayerSettingsMenu: (props: { container: HTMLElement | null }) => {
    menus.containers.push(props.container);
    return <button type="button" data-testid="settings-menu" />;
  },
}));

function show(props: Parameters<typeof LocalPlayer>[0] = { src: "/fixture.mp4" }, controller = new PlayerController()) {
  const result = render(
    <PlayerControllerProvider controller={controller}>
      <LocalPlayer {...props} />
    </PlayerControllerProvider>,
  );
  const root = screen.getByTestId("player-local");
  const video = root.querySelector("video") as HTMLVideoElement;
  return { ...result, controller, root, video };
}

/** The clock as the user reads it: the editable current time, then the total. */
function clockText(): string {
  const input = screen.getByTestId("player-clock-input") as HTMLInputElement;
  return `${input.value}${screen.getByTestId("player-clock-total").textContent ?? ""}`;
}

/** Makes the video's play() / pause() flip `paused` and fire the media events, as a browser would. */
function playable(video: HTMLVideoElement) {
  let paused = true;
  Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
  const play = vi.spyOn(video, "play").mockImplementation(() => {
    paused = false;
    fireEvent.play(video);
    return Promise.resolve();
  });
  const pause = vi.spyOn(video, "pause").mockImplementation(() => {
    paused = true;
    fireEvent.pause(video);
  });
  return { play, pause };
}

/** A fake Fullscreen API: requesting makes the element the document's fullscreen element. */
function fakeFullscreen() {
  let current: Element | null = null;
  const change = (next: Element | null): void => {
    current = next;
    act(() => {
      document.dispatchEvent(new Event("fullscreenchange"));
    });
  };
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => current });
  const request = vi.fn(function (this: Element) {
    change(this);
    return Promise.resolve();
  });
  const exit = vi.fn(() => {
    change(null);
    return Promise.resolve();
  });
  Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: request });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
  return { request, exit };
}

beforeEach(() => {
  localStorage.clear();
  settings.endBehavior = "pause";
  settings.autoplay = false;
  menus.containers.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, "fullscreenElement");
  Reflect.deleteProperty(document, "exitFullscreen");
  Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
});

describe("LocalPlayer", () => {
  it("has no subtitle menu, overlay or editor without subtitles", () => {
    const { root } = show();
    expect(root.querySelector("[data-subtitle-control]")).toBeNull();
    expect(screen.queryByTestId("subtitle-overlay")).toBeNull();
    expect(screen.queryByTestId("subtitle-editor")).toBeNull();
    expect([...root.querySelectorAll("[data-control]")].map((element) => element.getAttribute("data-control"))).toEqual(["play", "clock", "rate", "volume", "settings", "fullscreen"]);
  });

  it("seeks directly and skips with the arrow keys only while focused", () => {
    const { controller, root, video } = show();
    act(() => controller.seek(42_300));
    expect(Math.abs(video.currentTime * 1000 - 42_300)).toBeLessThanOrEqual(PLAYER_SEEK_TOLERANCE_MS);
    fireEvent.keyDown(root, { key: "ArrowRight" });
    expect(Math.round(video.currentTime)).toBe(42 + PLAYER_SKIP_SECONDS);
    fireEvent.keyDown(root, { key: "ArrowLeft" });
    expect(Math.round(video.currentTime)).toBe(42);
    expect(controller.capabilities.timeTracking).toBe("supported");
  });

  it("lands a seek within the tolerance of its target", () => {
    const { controller, video } = show({ src: "asset://localhost/fixture.mp4" });
    for (const ms of [0, 1_234, 3_599_999]) {
      act(() => controller.seek(ms));
      expect(Math.abs(video.currentTime * 1000 - ms)).toBeLessThanOrEqual(PLAYER_SEEK_TOLERANCE_MS);
    }
  });

  it("has a seek bar showing current and total time; dragging seeks and is not overwritten by playback", () => {
    const { video } = show();
    const bar = screen.getByTestId("player-seek") as HTMLInputElement;
    // Until the duration is known there is nothing to seek in.
    expect(bar.disabled).toBe(true);
    expect(clockText()).toBe("0:00 / --:--");
    Object.defineProperty(video, "duration", { configurable: true, value: 3_725 });
    fireEvent.loadedMetadata(video);
    expect(bar.disabled).toBe(false);
    expect(bar.max).toBe("3725000");
    expect(clockText()).toBe("0:00 / 1:02:05");

    fireEvent.change(bar, { target: { value: "600000" } });
    expect(video.currentTime).toBe(600);
    // A late time update from before the drag does not pull the bar back while it is held.
    video.currentTime = 5;
    fireEvent.timeUpdate(video);
    expect(bar.value).toBe("600000");
    expect(clockText()).toBe("10:00 / 1:02:05");
    fireEvent.pointerUp(bar);
    expect(bar.value).toBe("5000");
  });

  it("lays the controls over the picture: seek bar, then play · time · speed on the left and volume · settings · fullscreen on the right", () => {
    const { root } = show();
    const controls = within(root).getByTestId("player-controls");
    expect(within(root).getByTestId("player-overlay").contains(controls)).toBe(true);
    const order = [...controls.querySelectorAll<HTMLElement>("[data-control]")].map((element) => element.dataset["control"]);
    expect(order).toEqual(["play", "clock", "rate", "volume", "settings", "fullscreen"]);
    // The seek bar spans the row above the buttons.
    const seek = within(controls).getByTestId("player-seek");
    const play = controls.querySelector("[data-control='play']") as HTMLElement;
    expect(seek.compareDocumentPosition(play) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No ±10 s buttons and no autoplay checkbox any more; the menus pop up inside the player.
    expect(within(root).queryByRole("checkbox")).toBeNull();
    expect(within(root).queryByRole("button", { name: `后退 ${PLAYER_SKIP_SECONDS} 秒` })).toBeNull();
    expect(menus.containers.at(-1)).toBe(root);
  });

  it("covers the empty picture of an audio-only file, keeps its controls and offers no fullscreen", () => {
    const { request } = fakeFullscreen();
    const controller = new PlayerController();
    const { rerender, root, video } = show({ src: "/fixture.mp3", audioOnly: true }, controller);
    expect(screen.getByTestId("player-audio-only").textContent).toBe("仅音频，没有画面");
    act(() => controller.seek(5_000));
    expect(Math.round(video.currentTime)).toBe(5);
    expect(screen.getByTestId("player-seek")).toBeTruthy();
    expect(screen.queryByTestId("player-fullscreen")).toBeNull();
    fireEvent.keyDown(root, { key: "f" });
    fireEvent.doubleClick(video);
    expect(request).not.toHaveBeenCalled();
    // Nothing to look at, so the controls never hide while it plays.
    vi.useFakeTimers();
    fireEvent.play(video);
    fireEvent.pointerMove(root);
    act(() => vi.advanceTimersByTime(PLAYER_CONTROLS_IDLE_MS));
    expect(root.dataset["controls"]).toBe("shown");
    rerender(
      <PlayerControllerProvider controller={controller}>
        <LocalPlayer src="/fixture.mp4" />
      </PlayerControllerProvider>,
    );
    expect(screen.queryByTestId("player-audio-only")).toBeNull();
    expect(screen.getByTestId("player-fullscreen")).toBeTruthy();
  });

  it("plays and pauses on a click anywhere on the picture, the audio-only cover included, but not on the controls", () => {
    const { root, video } = show({ src: "/fixture.mp3", audioOnly: true });
    const { play, pause } = playable(video);
    // The cover lets clicks through to the video underneath.
    expect(screen.getByTestId("player-audio-only").className).toContain("pointer-events-none");
    fireEvent.click(video);
    expect(play).toHaveBeenCalledTimes(1);
    fireEvent.click(video);
    expect(pause).toHaveBeenCalledTimes(1);
    fireEvent.click(within(root).getByTestId("player-controls"));
    fireEvent.doubleClick(within(root).getByTestId("player-clock"));
    expect(play).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledTimes(1);
    // The play button names what it will do.
    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    expect(play).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "暂停" })).toBeTruthy();
  });

  it("jumps to a time typed into the clock, keeping the player's keys and clicks out of the field", () => {
    const { root, video } = show();
    const { play } = playable(video);
    Object.defineProperty(video, "duration", { configurable: true, value: 3_725 });
    fireEvent.loadedMetadata(video);
    const input = screen.getByRole("textbox", { name: "跳转到时间" }) as HTMLInputElement;
    expect(within(screen.getByTestId("player-clock")).getByTestId("player-clock-input")).toBe(input);

    // Clicking into the field is not a click on the picture.
    fireEvent.click(input);
    fireEvent.doubleClick(input);
    act(() => input.focus());
    // Space, arrows and F type into the field instead of driving the player.
    fireEvent.keyDown(input, { key: " " });
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(play).not.toHaveBeenCalled();
    expect(video.currentTime).toBe(0);

    fireEvent.change(input, { target: { value: "1:02:00" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(video.currentTime).toBe(3_720);
    expect(document.activeElement).toBe(root);
    // Back on the player, its keys work again.
    fireEvent.keyDown(root, { key: " " });
    expect(play).toHaveBeenCalledTimes(1);

    act(() => input.focus());
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(video.currentTime).toBe(3_720);
    expect(document.activeElement).toBe(root);
  });

  it("stays paused when the source refuses to play", async () => {
    const { video } = show({ src: "/missing.mp4" });
    Object.defineProperty(video, "paused", { configurable: true, get: () => true });
    const play = vi.spyOn(video, "play").mockRejectedValue(new DOMException("unsupported", "NotSupportedError"));
    fireEvent.click(video);
    await act(async () => {
      await Promise.resolve();
    });
    expect(play).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "播放" })).toBeTruthy();
  });

  it("restores the stored volume and mute, and keeps changes from the button, the slider and ↑ / ↓", () => {
    localStorage.setItem("amber.player.volume", "0.4");
    localStorage.setItem("amber.player.muted", "1");
    const { root, video, unmount } = show();
    expect(video.volume).toBe(0.4);
    expect(video.muted).toBe(true);
    expect(screen.getByTestId("player-volume-percent").textContent).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "取消静音" }));
    expect(video.muted).toBe(false);
    expect(localStorage.getItem("amber.player.muted")).toBe("0");
    expect(screen.getByTestId("player-volume-percent").textContent).toBe("40");

    fireEvent.keyDown(root, { key: "ArrowUp" });
    expect(video.volume).toBeCloseTo(0.4 + PLAYER_VOLUME_STEP);
    fireEvent.keyDown(root, { key: "ArrowDown" });
    fireEvent.keyDown(root, { key: "ArrowDown" });
    expect(video.volume).toBeCloseTo(0.4 - PLAYER_VOLUME_STEP);
    expect(Number(localStorage.getItem("amber.player.volume"))).toBeCloseTo(0.4 - PLAYER_VOLUME_STEP);
    // The level never leaves 0–1.
    for (let index = 0; index < 20; index += 1) fireEvent.keyDown(root, { key: "ArrowUp" });
    expect(video.volume).toBe(1);

    fireEvent.change(screen.getByTestId("player-volume-range"), { target: { value: "25" } });
    expect(video.volume).toBe(0.25);
    fireEvent.click(screen.getByRole("button", { name: "静音" }));
    expect(video.muted).toBe(true);
    unmount();

    const again = show();
    expect(again.video.volume).toBe(0.25);
    expect(again.video.muted).toBe(true);
  });

  it("sets the playback rate from the speed menu", () => {
    const { video } = show();
    fireEvent.click(screen.getByTestId("rate-menu"));
    expect(video.playbackRate).toBe(1.5);
    expect(video.defaultPlaybackRate).toBe(1.5);
    expect(screen.getByTestId("rate-menu").textContent).toBe("1.5×");
  });

  it("enters and leaves fullscreen on the player itself with F, the button and a double click on the picture", () => {
    const { request, exit } = fakeFullscreen();
    const { root, video } = show();
    fireEvent.keyDown(root, { key: "f" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.contexts[0]).toBe(root);
    expect(screen.getByRole("button", { name: "退出全屏" })).toBeTruthy();
    fireEvent.keyDown(root, { key: "F" });
    expect(exit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "全屏" })).toBeTruthy();

    fireEvent.click(screen.getByTestId("player-fullscreen"));
    expect(request).toHaveBeenCalledTimes(2);
    // Escape leaves fullscreen even where the host does not do it itself.
    fireEvent.keyDown(root, { key: "Escape" });
    expect(exit).toHaveBeenCalledTimes(2);

    fireEvent.doubleClick(video);
    expect(request).toHaveBeenCalledTimes(3);
    // Another element going fullscreen is not this player's fullscreen.
    act(() => {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => document.body });
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    expect(screen.getByRole("button", { name: "全屏" })).toBeTruthy();
  });

  it("ignores keys with Ctrl, Meta or Alt and keys meant for form controls", () => {
    const { request } = fakeFullscreen();
    const { root, video } = show();
    const { play } = playable(video);
    video.currentTime = 30;
    fireEvent.keyDown(root, { key: "ArrowRight", ctrlKey: true });
    fireEvent.keyDown(root, { key: "ArrowLeft", metaKey: true });
    fireEvent.keyDown(root, { key: " ", altKey: true });
    fireEvent.keyDown(root, { key: "f", ctrlKey: true });
    fireEvent.keyDown(root, { key: "ArrowUp", altKey: true });
    expect(video.currentTime).toBe(30);
    expect(play).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(video.volume).toBe(1);
    // The volume slider is an input: its arrows move the slider, not the player.
    fireEvent.keyDown(screen.getByTestId("player-volume-range"), { key: "ArrowLeft" });
    expect(video.currentTime).toBe(30);
  });

  it("hides the controls while playing after the pointer rests or leaves, leaving a progress line", () => {
    vi.useFakeTimers();
    const { root, video } = show();
    playable(video);
    expect(root.dataset["controls"]).toBe("shown");
    fireEvent.play(video);
    // Playing without the pointer over the picture: hidden at once.
    expect(root.dataset["controls"]).toBe("hidden");
    expect(within(root).getByTestId("player-progress-line")).toBeTruthy();
    fireEvent.pointerMove(root);
    expect(root.dataset["controls"]).toBe("shown");
    expect(within(root).queryByTestId("player-progress-line")).toBeNull();
    act(() => vi.advanceTimersByTime(PLAYER_CONTROLS_IDLE_MS - 1));
    expect(root.dataset["controls"]).toBe("shown");
    act(() => vi.advanceTimersByTime(1));
    expect(root.dataset["controls"]).toBe("hidden");
    fireEvent.pointerMove(root);
    fireEvent.pointerLeave(root);
    expect(root.dataset["controls"]).toBe("hidden");

    // An open menu keeps them.
    fireEvent.pointerMove(root);
    fireEvent.click(screen.getByTestId("rate-menu-open"));
    act(() => vi.advanceTimersByTime(PLAYER_CONTROLS_IDLE_MS));
    expect(root.dataset["controls"]).toBe("shown");
    fireEvent.click(screen.getByTestId("rate-menu-close"));
    expect(root.dataset["controls"]).toBe("hidden");

    // Keyboard focus inside them keeps them; a mouse click's focus does not.
    const matches = vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
      return selector === ":focus-visible";
    });
    act(() => screen.getByTestId("settings-menu").focus());
    expect(root.dataset["controls"]).toBe("shown");
    act(() => root.focus());
    expect(root.dataset["controls"]).toBe("hidden");
    matches.mockRestore();
    act(() => screen.getByTestId("settings-menu").focus());
    expect(root.dataset["controls"]).toBe("hidden");

    // Paused: always shown.
    fireEvent.pause(video);
    expect(root.dataset["controls"]).toBe("shown");
  });

  it("follows the play mode at the end: loops one file, or asks the list for the next and replays when it says so", async () => {
    settings.endBehavior = "loop_one";
    const first = show();
    expect(first.video.loop).toBe(true);
    first.unmount();

    settings.endBehavior = "loop_list";
    let answer: AdvanceResult = "replay";
    const onEndedAdvance = vi.fn(async () => answer);
    const { video, unmount } = show({ src: "/fixture.mp4", onEndedAdvance });
    expect(video.loop).toBe(false);
    const { play } = playable(video);
    video.currentTime = 99;
    fireEvent.ended(video);
    await act(async () => {
      await Promise.resolve();
    });
    expect(onEndedAdvance).toHaveBeenCalledTimes(1);
    expect(video.currentTime).toBe(0);
    expect(play).toHaveBeenCalledTimes(1);
    answer = "stay";
    video.currentTime = 99;
    fireEvent.ended(video);
    await act(async () => {
      await Promise.resolve();
    });
    expect(onEndedAdvance).toHaveBeenCalledTimes(2);
    expect(video.currentTime).toBe(99);
    expect(play).toHaveBeenCalledTimes(1);
    unmount();

    settings.endBehavior = "pause";
    const paused = show({ src: "/fixture.mp4", onEndedAdvance });
    fireEvent.ended(paused.video);
    expect(onEndedAdvance).toHaveBeenCalledTimes(2);
  });

  it("starts by itself when the autoplay setting is on or the list loop asks for it", () => {
    const off = show();
    expect(off.video.autoplay).toBe(false);
    off.unmount();
    const forced = show({ src: "/fixture.mp4", autoplay: true });
    expect(forced.video.autoplay).toBe(true);
    forced.unmount();
    settings.autoplay = true;
    expect(show().video.autoplay).toBe(true);
  });
});
