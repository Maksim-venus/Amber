import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initI18n } from "../../../src/web/i18n.ts";
import { PasswordField } from "../../../src/web/ui/password-input.tsx";

initI18n();

function Form(props: { onSubmit?: () => void }) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit?.();
      }}
    >
      <PasswordField label="密码" autoComplete="new-password" defaultValue="<shown-password>" className="field" />
      <button type="submit">提交</button>
    </form>
  );
}

describe("PasswordInput", () => {
  it("starts hidden and toggles to plain text and back", () => {
    render(<Form />);
    const input = screen.getByLabelText("密码");
    const toggle = screen.getByRole("button", { name: "显示密码" });
    expect(input.getAttribute("type")).toBe("password");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(input.getAttribute("type")).toBe("text");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(input.getAttribute("type")).toBe("password");
  });

  it("keeps spell checking off, passes its attributes on and keeps the toggle out of the label", () => {
    const { container } = render(<Form />);
    const input = screen.getByLabelText("密码");
    const label = container.querySelector("label") as HTMLLabelElement;
    expect(label.htmlFor).toBe(input.id);
    expect(label.contains(screen.getByRole("button", { name: "显示密码" }))).toBe(false);
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(input.getAttribute("autocorrect")).toBe("off");
    expect(input.getAttribute("autocapitalize")).toBe("off");
    expect(input.getAttribute("autocomplete")).toBe("new-password");
    expect(input.className).toContain("field");
    expect((input as HTMLInputElement).value).toBe("<shown-password>");
  });

  it("hides the text again when the form is submitted", () => {
    let submitted = 0;
    render(<Form onSubmit={() => (submitted += 1)} />);
    const input = screen.getByLabelText("密码");
    fireEvent.click(screen.getByRole("button", { name: "显示密码" }));
    expect(input.getAttribute("type")).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(submitted).toBe(1);
    expect(input.getAttribute("type")).toBe("password");
  });
});
