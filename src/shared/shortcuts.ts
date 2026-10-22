import { SHORTCUT_HELP_DEFAULT, SHORTCUT_NEW_SUMMARY_DEFAULT, SHORTCUT_OMNIBOX_DEFAULT } from "./defaults.ts";

/** Actions bound through `ShortcutRegistry` (`ShortcutAction`). */
export const SHORTCUT_ACTIONS = ["omnibox", "newSummary", "shortcutHelp"] as const;
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

export const SHORTCUT_DEFAULTS: Readonly<Record<ShortcutAction, string>> = {
  omnibox: SHORTCUT_OMNIBOX_DEFAULT,
  newSummary: SHORTCUT_NEW_SUMMARY_DEFAULT,
  shortcutHelp: SHORTCUT_HELP_DEFAULT,
};

/**
 * Combinations a page cannot or should not claim: the keys Chrome
 * keeps for tabs and windows, the DevTools keys, and Alt+F4. `Ctrl+Alt` combinations are
 * rejected separately because Windows reads them as AltGr.
 */
export const RESERVED_SHORTCUTS: ReadonlySet<string> = new Set([
  "Ctrl+N",
  "Ctrl+T",
  "Ctrl+W",
  "Ctrl+Shift+N",
  "Ctrl+Shift+T",
  "Ctrl+Shift+W",
  "Ctrl+Tab",
  "Ctrl+Shift+Tab",
  "Ctrl+PageUp",
  "Ctrl+PageDown",
  "Ctrl+Shift+I",
  "Ctrl+Shift+J",
  "Ctrl+Shift+C",
  "F12",
  "Alt+F4",
]);

/**
 * Browser keys the desktop client keeps from the WebView: reload, print,
 * find, the downloads panel and caret browsing. `Ctrl+S` is already off in WebView2; zoom,
 * `Esc` and `Alt+←/→` stay. A user binding on one of these keys still wins.
 */
export const DESKTOP_BLOCKED_BROWSER_KEYS: readonly string[] = [
  "F5",
  "Ctrl+R",
  "Ctrl+Shift+R",
  "Ctrl+F5",
  "Shift+F5",
  "BrowserRefresh",
  "Ctrl+P",
  "Ctrl+F",
  "F3",
  "Shift+F3",
  "Ctrl+G",
  "Ctrl+Shift+G",
  "Ctrl+J",
  "F7",
];

const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"] as const;

/**
 * Canonical notation of a shortcut, as the named default shortcuts are written: modifiers in
 * `Ctrl+Alt+Shift+Meta` order, then one key (`K`, `/`, `F5`, `PageUp` …). Returns undefined for anything that is not a combination.
 */
export function normalizeShortcut(combo: string): string | undefined {
  const parts = combo.split("+").map((part) => part.trim());
  // "Ctrl++" style: a trailing "+" key splits into two empty parts.
  if (parts.length >= 2 && parts.at(-1) === "" && parts.at(-2) === "") {
    parts.splice(-2, 2, "+");
  }
  const key = parts.pop();
  if (key === undefined || key === "" || (MODIFIERS as readonly string[]).includes(key)) {
    return undefined;
  }
  const modifiers = new Set<string>();
  for (const part of parts) {
    const modifier = MODIFIERS.find((name) => name.toLowerCase() === part.toLowerCase());
    if (modifier === undefined || modifiers.has(modifier)) {
      return undefined;
    }
    modifiers.add(modifier);
  }
  const normalizedKey = key.length === 1 ? key.toUpperCase() : key;
  return [...MODIFIERS.filter((name) => modifiers.has(name)), normalizedKey].join("+");
}

export type ShortcutProblem = "invalid" | "reserved" | "duplicate";

/**
 * Validates a complete effective binding: every combination parses, needs a modifier or a
 * function key, is not reserved, and no two actions share one.
 */
export function shortcutProblems(bindings: Readonly<Record<ShortcutAction, string>>): Partial<Record<ShortcutAction, ShortcutProblem>> {
  const problems: Partial<Record<ShortcutAction, ShortcutProblem>> = {};
  const seen = new Map<string, ShortcutAction>();
  for (const action of SHORTCUT_ACTIONS) {
    const combo = normalizeShortcut(bindings[action]);
    if (combo === undefined || !(combo.includes("+") || /^F\d{1,2}$/.test(combo))) {
      problems[action] = "invalid";
      continue;
    }
    if (RESERVED_SHORTCUTS.has(combo) || (combo.includes("Ctrl+") && combo.includes("Alt+"))) {
      problems[action] = "reserved";
      continue;
    }
    const other = seen.get(combo);
    if (other !== undefined) {
      problems[action] = "duplicate";
      problems[other] ??= "duplicate";
      continue;
    }
    seen.set(combo, action);
  }
  return problems;
}

/** Stored overrides on top of the named default shortcuts. */
export function effectiveShortcuts(overrides: Partial<Record<ShortcutAction, string>>): Record<ShortcutAction, string> {
  return { ...SHORTCUT_DEFAULTS, ...overrides };
}
