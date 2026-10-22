import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { chapterAt, SeekBar, seekTrackGradient } from "../../../src/web/player/seek-bar.tsx";

const chapter = (startMs: number, endMs: number, title: string) => ({ startMs, endMs, title });
const CHAPTERS = [chapter(0, 25_000, "开场"), chapter(25_000, 75_000, "正文"), chapter(75_000, 100_000, "总结")];

function bar(props: Partial<Parameters<typeof SeekBar>[0]> = {}) {
  const onScrub = vi.fn();
  const onScrubEnd = vi.fn();
  render(<SeekBar durationMs={100_000} positionMs={50_000} chapters={CHAPTERS} onScrub={onScrub} onScrubEnd={onScrubEnd} {...props} />);
  const input = screen.getByTestId("player-seek") as HTMLInputElement;
  vi.spyOn(input, "getBoundingClientRect").mockReturnValue({ left: 100, width: 400, top: 0, height: 16, right: 500, bottom: 16, x: 100, y: 0, toJSON: () => ({}) });
  return { input, onScrub, onScrubEnd };
}

describe("seekTrackGradient", () => {
  it("is one continuous bar without chapters: played up to the position, the rest translucent", () => {
    expect(seekTrackGradient(100_000, 40_000, [])).toBe(
      "linear-gradient(90deg, var(--color-accent) 0%, var(--color-accent) 40%, var(--seek-rest) 40%, var(--seek-rest) 100%)",
    );
    expect(seekTrackGradient(0, 0, CHAPTERS)).toBe("linear-gradient(90deg, var(--seek-rest) 0%, var(--seek-rest) 100%)");
  });

  it("leaves a transparent gap at each chapter boundary and splits the played part inside its chapter", () => {
    const gradient = seekTrackGradient(100_000, 50_000, CHAPTERS);
    expect(gradient).toBe(
      [
        "linear-gradient(90deg, var(--color-accent) 0%",
        "var(--color-accent) calc(25% - 1px)",
        "transparent calc(25% - 1px)",
        "transparent calc(25% + 1px)",
        "var(--color-accent) calc(25% + 1px)",
        "var(--color-accent) 50%",
        "var(--seek-rest) 50%",
        "var(--seek-rest) calc(75% - 1px)",
        "transparent calc(75% - 1px)",
        "transparent calc(75% + 1px)",
        "var(--seek-rest) calc(75% + 1px)",
        "var(--seek-rest) 100%)",
      ].join(", "),
    );
    // A chapter starting at 0 or past the end draws no gap.
    expect(seekTrackGradient(100_000, 0, [chapter(0, 100_000, "全部"), chapter(120_000, 130_000, "越界")])).not.toContain("transparent");
  });

  it("finds the chapter under a time", () => {
    expect(chapterAt(CHAPTERS, 0)?.title).toBe("开场");
    expect(chapterAt(CHAPTERS, 74_999)?.title).toBe("正文");
    expect(chapterAt(CHAPTERS, 100_000)?.title).toBe("总结");
    expect(chapterAt([chapter(10_000, 20_000, "后来")], 5_000)).toBeUndefined();
  });
});

describe("SeekBar", () => {
  it("paints the track through a custom property on the range", () => {
    const { input } = bar();
    expect(input.style.getPropertyValue("--seek-track")).toBe(seekTrackGradient(100_000, 50_000, CHAPTERS));
    expect(input.getAttribute("aria-label")).toBe("播放进度");
    expect(input.step).toBe("1000");
  });

  it("shows the time and chapter under the pointer and hides the tooltip when it leaves", () => {
    const { input } = bar();
    fireEvent.pointerMove(input, { clientX: 100 + 200 });
    const tooltip = screen.getByTestId("player-seek-tooltip");
    expect(tooltip.textContent).toBe("0:50 · 正文");
    expect(tooltip.style.left).toBe("200px");
    fireEvent.pointerMove(input, { clientX: 100 + 40 });
    expect(screen.getByTestId("player-seek-tooltip").textContent).toBe("0:10 · 开场");
    // Past either end the pointer is clamped to the bar.
    fireEvent.pointerMove(input, { clientX: 900 });
    expect(screen.getByTestId("player-seek-tooltip").textContent).toBe("1:40 · 总结");
    fireEvent.pointerLeave(input);
    expect(screen.queryByTestId("player-seek-tooltip")).toBeNull();
  });

  it("shows only the time without chapters", () => {
    const { input } = bar({ chapters: [] });
    fireEvent.pointerMove(input, { clientX: 100 + 100 });
    expect(screen.getByTestId("player-seek-tooltip").textContent).toBe("0:25");
  });

  it("has no tooltip and no seeking before the duration is known", () => {
    const { input } = bar({ durationMs: undefined });
    expect(input.disabled).toBe(true);
    fireEvent.pointerMove(input, { clientX: 300 });
    expect(screen.queryByTestId("player-seek-tooltip")).toBeNull();
  });

  it("reports the dragged position and the end of the drag", () => {
    const { input, onScrub, onScrubEnd } = bar();
    fireEvent.change(input, { target: { value: "30000" } });
    expect(onScrub).toHaveBeenCalledWith(30_000);
    fireEvent.pointerUp(input);
    fireEvent.keyUp(input, { key: "ArrowRight" });
    fireEvent.blur(input);
    expect(onScrubEnd).toHaveBeenCalledTimes(3);
  });
});
