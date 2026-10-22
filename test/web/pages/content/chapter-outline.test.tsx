import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChapterOutline } from "../../../../src/web/pages/content/chapter-outline.tsx";

const ENTRIES = [
  { index: 0, startMs: 0, title: "开场" },
  { index: 3, startMs: 3_725_000, title: "一个很长很长的章节标题" },
];

describe("ChapterOutline", () => {
  it("lists each entry as time and title under a counted heading, and stays closed until opened", () => {
    render(<ChapterOutline entries={ENTRIES} onPick={() => undefined} />);
    expect(screen.queryByTestId("chapter-outline-list")).toBeNull();
    const trigger = screen.getByTestId("chapter-outline");
    expect(trigger.textContent).toBe("章节");
    fireEvent.click(trigger);
    expect(screen.getByText("章节目录（2）")).toBeTruthy();
    const items = within(screen.getByTestId("chapter-outline-list")).getAllByTestId("chapter-outline-item");
    expect(items.map((item) => item.textContent)).toEqual(["0:00开场", "1:02:05一个很长很长的章节标题"]);
    // Each row is one button named by both its time and its title, never by the time alone.
    expect(screen.queryByRole("button", { name: "0:00" })).toBeNull();
  });

  it("hands the picked row index back and closes", () => {
    const onPick = vi.fn<(index: number) => void>();
    render(<ChapterOutline entries={ENTRIES} onPick={onPick} />);
    fireEvent.click(screen.getByTestId("chapter-outline"));
    fireEvent.click(screen.getAllByTestId("chapter-outline-item")[1] as HTMLElement);
    expect(onPick).toHaveBeenCalledExactlyOnceWith(3);
    expect(screen.queryByTestId("chapter-outline-list")).toBeNull();
  });

  it("toggles closed from its own button and on Escape", () => {
    render(<ChapterOutline entries={ENTRIES} onPick={() => undefined} />);
    const trigger = screen.getByTestId("chapter-outline");
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByTestId("chapter-outline-list")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByTestId("chapter-outline-list")).toBeNull();
  });

  it("is disabled and says why when there are no chapters", () => {
    render(<ChapterOutline entries={[]} onPick={() => undefined} />);
    const trigger = screen.getByTestId("chapter-outline") as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(trigger.title).toBe("尚无章节");
    fireEvent.click(trigger);
    expect(screen.queryByTestId("chapter-outline-list")).toBeNull();
  });
});
