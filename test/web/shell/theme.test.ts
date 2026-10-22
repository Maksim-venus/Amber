import { afterEach, describe, expect, it } from "vitest";
import { THEME_DEFAULT } from "../../../src/shared/defaults.ts";
import { THEMES } from "../../../src/shared/dto/settings.ts";
import { applyTheme, nextTheme } from "../../../src/web/shell/theme.ts";

const root = document.documentElement;

afterEach(() => {
  delete root.dataset["theme"];
  root.classList.remove("dark");
});

describe("applyTheme", () => {
  it("names every theme on the root and sets `dark` only for the dark theme", () => {
    for (const theme of THEMES) {
      applyTheme(theme);
      expect(root.dataset["theme"]).toBe(theme);
      expect(root.classList.contains("dark")).toBe(theme === "dark");
    }
  });

  it("keeps the eye-care themes light after leaving the dark theme", () => {
    applyTheme("dark");
    applyTheme("bean-green");
    expect(root.dataset["theme"]).toBe("bean-green");
    expect(root.classList.contains("dark")).toBe(false);
    applyTheme("parchment");
    expect(root.dataset["theme"]).toBe("parchment");
    expect(root.classList.contains("dark")).toBe(false);
  });

  it("falls back to the default for a missing or unknown theme", () => {
    applyTheme("dark");
    applyTheme(undefined);
    expect(root.dataset["theme"]).toBe(THEME_DEFAULT);
    expect(root.classList.contains("dark")).toBe(false);
    applyTheme("blue");
    expect(root.dataset["theme"]).toBe(THEME_DEFAULT);
  });
});

describe("nextTheme", () => {
  it("cycles through every theme in order and comes back to the start", () => {
    const seen = [THEME_DEFAULT as string];
    let theme = nextTheme(THEME_DEFAULT);
    while (theme !== THEME_DEFAULT) {
      seen.push(theme);
      theme = nextTheme(theme);
    }
    expect(seen).toEqual([...THEMES]);
  });

  it("starts from the default when the setting is not loaded yet", () => {
    expect(nextTheme(undefined)).toBe(nextTheme(THEME_DEFAULT));
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("parchment")).toBe("light");
  });
});
