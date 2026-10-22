import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Highlighted } from "../../../src/web/search/highlighted.tsx";

describe("Highlighted", () => {
  it("marks the given spans as text, never as markup", () => {
    const { container } = render(<Highlighted text="<b>检索</b> 增强" ranges={[{ start: 3, end: 5 }]} />);
    expect([...container.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["检索"]);
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toBe("<b>检索</b> 增强");
  });

  it("renders plain text without ranges", () => {
    const { container } = render(<Highlighted text="原文" ranges={[]} />);
    expect(container.querySelector("mark")).toBeNull();
    expect(container.textContent).toBe("原文");
  });
});
