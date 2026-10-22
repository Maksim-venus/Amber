import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "../../../src/web/ui/clipboard.ts";

function select(text: string): { node: Text; button: HTMLButtonElement } {
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  const button = document.createElement("button");
  document.body.append(paragraph, button);
  // jsdom moves the selection on focus, so focus before selecting.
  button.focus();
  const node = paragraph.firstChild as Text;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, 3);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  return { node, button };
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

describe("copyText", () => {
  it("uses the async clipboard when it is there", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyText("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand without a clipboard and puts the selection and focus back", async () => {
    vi.stubGlobal("navigator", {});
    const { node, button } = select("abcdef");
    let copiedFrom = "";
    document.execCommand = vi.fn(() => {
      copiedFrom = (document.activeElement as HTMLTextAreaElement).value;
      return true;
    });
    await expect(copyText("hello")).resolves.toBe(true);
    expect(copiedFrom).toBe("hello");
    const range = window.getSelection()?.getRangeAt(0);
    expect(range?.startContainer).toBe(node);
    expect(range?.endOffset).toBe(3);
    expect(document.activeElement).toBe(button);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back when the clipboard refuses and reports a failure when both fail", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    document.execCommand = vi.fn(() => true);
    await expect(copyText("x")).resolves.toBe(true);
    document.execCommand = vi.fn(() => false);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(copyText("x")).resolves.toBe(false);
  });
});
