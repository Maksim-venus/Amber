import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RichText } from "../../../src/web/components/rich-text.tsx";

describe("RichText", () => {
  it("renders [[seg:]] as a clickable timestamp and [[unresolved:]] as a notice", () => {
    const onCitation = vi.fn();
    const { container } = render(
      <RichText source={"要点一 [[seg:01ABC]]，要点二 [[unresolved:s9]]。"} timeOf={(id) => (id === "01ABC" ? 75_000 : undefined)} onCitation={onCitation} />,
    );
    const citation = screen.getByRole("button", { name: "1:15" });
    fireEvent.click(citation);
    expect(onCitation).toHaveBeenCalledWith("01ABC");
    expect(container.textContent).toContain("引用无法定位");
    expect(container.textContent).not.toContain("[[");
  });

  it("shows raw HTML as text and drops unsafe link schemes", () => {
    const { container } = render(
      <RichText source={'<img src=x onerror="alert(1)"><script>alert(1)</script> [a](javascript:alert(1)) [b](https://example.com)'} />,
    );
    expect(container.querySelector("img, script, [onerror]")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)"><script>alert(1)</script>');
    const links = [...container.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([null, "https://example.com"]);
    expect(links.every((link) => link.getAttribute("rel") === "noopener noreferrer")).toBe(true);
  });

  it("keeps block-level raw HTML as text with citations still resolved", () => {
    const { container } = render(<RichText source={'<div onclick="alert(1)">块 [[seg:01ABC]]</div>\n\n段落'} />);
    expect(container.querySelector("div[onclick]")).toBeNull();
    expect(container.textContent).toContain('<div onclick="alert(1)">块');
    expect(container.querySelector('[data-citation="01ABC"]')).not.toBeNull();
  });

  it("leaves markers inside code untouched", () => {
    const { container } = render(<RichText source={"`[[seg:01ABC]]`"} />);
    expect(container.querySelector("code")?.textContent).toBe("[[seg:01ABC]]");
    expect(container.querySelector("[data-citation]")).toBeNull();
  });
});
