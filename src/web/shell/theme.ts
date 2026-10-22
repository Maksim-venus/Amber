import { THEME_DEFAULT } from "../../shared/defaults.ts";
import { THEMES, type Theme } from "../../shared/dto/settings.ts";

/**
 * Names the theme on the document root, where the stylesheet keys its palette. `.dark` is
 * set only for the dark theme: it drives the `dark:` variant, and the eye-care themes are
 * light. Unknown values fall back to the default; the theme never follows the system.
 */
export function applyTheme(theme: string | undefined): void {
  const next = THEMES.find((option) => option === theme) ?? THEME_DEFAULT;
  const root = document.documentElement;
  root.dataset["theme"] = next;
  root.classList.toggle("dark", next === "dark");
}

/** The theme after `current` in the order of `THEMES`; the "toggle theme" command cycles through them. */
export function nextTheme(current: Theme | undefined): Theme {
  const index = THEMES.indexOf(current ?? THEME_DEFAULT);
  return THEMES[(index + 1) % THEMES.length] ?? THEME_DEFAULT;
}
