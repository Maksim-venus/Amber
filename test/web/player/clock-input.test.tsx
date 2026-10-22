import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { formatDuration } from "../../../src/web/format.ts";
import { ClockInput, parseClock } from "../../../src/web/player/clock-input.tsx";

function clock(props: Partial<Parameters<typeof ClockInput>[0]> = {}) {
  const onSeek = vi.fn();
  const onDone = vi.fn();
  const all = { positionMs: 65_000, durationMs: 3_725_000, onSeek, onDone, ...props };
  const result = render(<ClockInput {...all} />);
  const input = screen.getByTestId("player-clock-input") as HTMLInputElement;
  return { ...result, input, onSeek, onDone, props: all };
}

/** Focuses the field and replaces its text, as typing over the select-all would. */
function type(input: HTMLInputElement, text: string): void {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: text } });
}

describe("parseClock", () => {
  it.each([
    ["90", 90_000],
    ["0", 0],
    ["1:30", 90_000],
    ["0:05", 5_000],
    ["90:00", 5_400_000],
    ["1:02:03", 3_723_000],
    ["1:2:3", 3_723_000],
    ["1：30", 90_000],
    ["1：02：03", 3_723_000],
    [" 2:00 ", 120_000],
  ])("reads %j as %i ms", (text, ms) => {
    expect(parseClock(text)).toBe(ms);
  });

  it.each(["", "   ", "abc", "1:60", "1:00:60", "1:60:00", "1:2:3:4", "-5", "1.5", "+5", "1::2", ":30", "30:", "1 : 30", "1e3"])(
    "rejects %j",
    (text) => {
      expect(parseClock(text)).toBeUndefined();
    },
  );

  it("reads back every whole-second time formatDuration writes", () => {
    for (const ms of [0, 5_000, 59_000, 60_000, 90_000, 599_000, 3_599_000, 3_600_000, 3_723_000, 36_000_000]) {
      expect(parseClock(formatDuration(ms))).toBe(ms);
    }
  });
});

describe("ClockInput", () => {
  it("shows the current time, labelled, hugging it at rest and making room for the total while editing", () => {
    const { input, rerender, props } = clock();
    expect(input.value).toBe("1:05");
    expect(input.type).toBe("text");
    expect(screen.getByRole("textbox", { name: "跳转到时间" })).toBe(input);
    expect(input.style.width).toBe("4ch");
    rerender(<ClockInput {...props} positionMs={3_700_000} />);
    expect(input.value).toBe("1:01:40");
    expect(input.style.width).toBe("7ch");
    rerender(<ClockInput {...props} positionMs={0} />);
    fireEvent.focus(input);
    expect(input.style.width).toBe("7ch");
    fireEvent.blur(input);
    rerender(<ClockInput {...props} positionMs={0} durationMs={undefined} />);
    fireEvent.focus(input);
    expect(input.style.width).toBe("4ch");
  });

  it("selects everything on focus and keeps a click from collapsing that selection once", () => {
    const { input } = clock();
    fireEvent.mouseDown(input);
    input.focus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    // The first mouseup after a click focus is the one that would place the caret.
    expect(fireEvent.mouseUp(input)).toBe(false);
    fireEvent.mouseDown(input);
    expect(fireEvent.mouseUp(input)).toBe(true);
  });

  it("jumps to the typed time on Enter, clamped to the media, then hands focus back", () => {
    const { input, onSeek, onDone } = clock();
    type(input, "1:00:00");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSeek).toHaveBeenLastCalledWith(3_600_000);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("1:05");

    type(input, "9:00:00");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSeek).toHaveBeenLastCalledWith(3_725_000);
    expect(onDone).toHaveBeenCalledTimes(2);
  });

  it("only bounds below while the duration is unknown", () => {
    const { input, onSeek } = clock({ durationMs: undefined });
    type(input, "9:00:00");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSeek).toHaveBeenLastCalledWith(32_400_000);
    type(input, "0");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSeek).toHaveBeenLastCalledWith(0);
  });

  it("does not seek on an invalid time, puts the current time back and still ends the edit", () => {
    const { input, onSeek, onDone } = clock();
    type(input, "1:75");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSeek).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("1:05");
  });

  it("drops the edit on Escape without seeking, and keeps the key to itself", () => {
    const onParentKey = vi.fn();
    const onSeek = vi.fn();
    const onDone = vi.fn();
    render(
      <div onKeyDown={onParentKey}>
        <ClockInput positionMs={65_000} durationMs={3_725_000} onSeek={onSeek} onDone={onDone} />
      </div>,
    );
    const input = screen.getByTestId("player-clock-input") as HTMLInputElement;
    type(input, "2:00");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onSeek).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onParentKey).not.toHaveBeenCalled();
    expect(input.value).toBe("1:05");
  });

  it("drops the edit when focus leaves", () => {
    const { input, onSeek, onDone } = clock();
    type(input, "2:00");
    fireEvent.blur(input);
    expect(input.value).toBe("1:05");
    expect(onSeek).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("treats an Enter that confirms an IME composition as typing, not a jump", () => {
    const { input, onSeek, onDone } = clock();
    type(input, "2：00");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onSeek).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(input.value).toBe("2：00");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSeek).toHaveBeenLastCalledWith(120_000);
  });

  it("keeps the draft while focused even as playback moves on", () => {
    const { input, rerender, props } = clock();
    fireEvent.focus(input);
    rerender(<ClockInput {...props} positionMs={70_000} />);
    expect(input.value).toBe("1:05");
    fireEvent.change(input, { target: { value: "3:" } });
    rerender(<ClockInput {...props} positionMs={75_000} />);
    expect(input.value).toBe("3:");
    fireEvent.blur(input);
    expect(input.value).toBe("1:15");
  });
});
