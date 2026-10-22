import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecoratedText, runClasses, textPieces } from "../../../src/web/notes/decorated-text.tsx";
import type { SentenceNote } from "../../../src/web/notes/note-anchor.ts";
import { note } from "../../fixtures/web/note-data.ts";

afterEach(() => {
  window.getSelection()?.removeAllRanges();
});

const placed = (id: string, start: number, end: number, overrides: Parameters<typeof note>[1] = {}, last = true): SentenceNote => ({
  note: note(id, overrides),
  start,
  end,
  last,
});

function sentence(ui: React.ReactNode): HTMLElement {
  render(<span data-testid="sentence">{ui}</span>);
  return screen.getByTestId("sentence");
}

describe("DecoratedText", () => {
  it("renders undecorated text as exactly one text node", () => {
    const element = sentence(<DecoratedText text="今天讲检索。" notes={[]} search={[]} />);
    expect(element.childNodes.length).toBe(1);
    expect(element.firstChild?.nodeType).toBe(Node.TEXT_NODE);
  });

  it("cuts runs at note and search edges and keeps the sentence text unchanged", () => {
    const notes = [placed("n1", 0, 4, { createdAt: 1 }), placed("n2", 2, 6, { createdAt: 2, mark: "underline", color: "green" })];
    const element = sentence(<DecoratedText text="今天讲检索。" notes={notes} search={[{ start: 3, end: 5 }]} />);
    expect(element.textContent).toBe("今天讲检索。");
    expect(screen.getAllByTestId("note-run").map((run) => [run.textContent, run.dataset["noteIds"]])).toEqual([
      ["今天", "n1"],
      ["讲", "n2 n1"],
      ["检", "n2 n1"],
      ["索", "n2"],
      ["。", "n2"],
    ]);
    // The search hit stays a <mark> inside the runs it crosses, drawn above their backgrounds.
    expect([...element.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["检", "索"]);
  });

  it("takes the newest background and the newest underline colour for a run", () => {
    const classes = runClasses([
      placed("old", 0, 2, { createdAt: 1, color: "green" }),
      placed("new", 0, 2, { createdAt: 5, color: "pink" }),
      placed("u1", 0, 2, { createdAt: 9, mark: "underline", color: "blue" }),
      placed("u2", 0, 2, { createdAt: 9, mark: "underline", color: "purple" }),
    ]);
    expect(classes).toContain("bg-pink-300/60");
    expect(classes).not.toContain("bg-green");
    // Same creation time: the larger id wins.
    expect(classes).toContain("decoration-violet-500");
    expect(classes).not.toContain("decoration-sky");
  });

  it("puts a decorative badge where a commented note ends in its last sentence", () => {
    const notes = [placed("n1", 0, 2, { comment: "想法" }), placed("n2", 3, 5, { comment: "另一句" }, false)];
    const element = sentence(<DecoratedText text="今天讲检索。" notes={notes} />);
    const badges = element.querySelectorAll("[data-note-badge]");
    expect(badges.length).toBe(1);
    expect(badges[0]?.getAttribute("aria-hidden")).toBe("true");
    expect(badges[0]?.textContent).toBe("");
    expect(screen.getAllByTestId("note-run")[0]?.getAttribute("aria-label")).toBe("1 条笔记，有评论");
  });

  it("opens from a click, Enter or Space without the click reaching the sentence", () => {
    const onOpen = vi.fn<(ids: string[]) => void>();
    const onSentence = vi.fn();
    render(
      <span onClick={onSentence}>
        <DecoratedText text="今天讲检索。" notes={[placed("n1", 0, 2)]} onOpenNotes={(ids) => onOpen(ids)} />
      </span>,
    );
    const run = screen.getByTestId("note-run");
    expect(run.getAttribute("role")).toBe("button");
    expect(run.tabIndex).toBe(0);
    fireEvent.click(run);
    fireEvent.keyDown(run, { key: "Enter" });
    fireEvent.keyDown(run, { key: " " });
    fireEvent.keyDown(run, { key: "a" });
    expect(onOpen.mock.calls).toEqual([[["n1"]], [["n1"]], [["n1"]]]);
    expect(onSentence).not.toHaveBeenCalled();
  });

  it("ignores the click that ends a text selection", () => {
    const onOpen = vi.fn();
    render(<DecoratedText text="今天讲检索。" notes={[placed("n1", 0, 4)]} onOpenNotes={onOpen} />);
    const run = screen.getByTestId("note-run");
    const range = document.createRange();
    range.setStart(run.firstChild as Text, 0);
    range.setEnd(run.firstChild as Text, 2);
    window.getSelection()?.addRange(range);
    fireEvent.click(run);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("merges neighbouring pieces with the same notes", () => {
    expect(textPieces(6, [placed("n1", 0, 6)], [{ start: 6, end: 6 }]).map((piece) => [piece.start, piece.end])).toEqual([[0, 6]]);
  });
});
