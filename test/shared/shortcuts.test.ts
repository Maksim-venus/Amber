import { describe, expect, it } from "vitest";
import { SHORTCUT_HELP_DEFAULT, SHORTCUT_NEW_SUMMARY_DEFAULT, SHORTCUT_OMNIBOX_DEFAULT } from "../../src/shared/defaults.ts";
import { effectiveShortcuts, normalizeShortcut, RESERVED_SHORTCUTS, SHORTCUT_DEFAULTS, shortcutProblems } from "../../src/shared/shortcuts.ts";

describe("normalizeShortcut", () => {
  it("orders modifiers canonically, upper-cases letters and keeps named keys", () => {
    expect(normalizeShortcut("shift+ctrl+o")).toBe("Ctrl+Shift+O");
    expect(normalizeShortcut("Meta+alt+k")).toBe("Alt+Meta+K");
    expect(normalizeShortcut("Ctrl+/")).toBe("Ctrl+/");
    expect(normalizeShortcut("Ctrl+PageUp")).toBe("Ctrl+PageUp");
    expect(normalizeShortcut("Ctrl++")).toBe("Ctrl++");
    expect(normalizeShortcut("F5")).toBe("F5");
  });

  it("rejects modifiers alone, repeated or unknown modifiers and empty input", () => {
    for (const combo of ["", "Ctrl", "Ctrl+Shift", "Ctrl+Ctrl+K", "Hyper+K", "Ctrl+"]) {
      expect(normalizeShortcut(combo), combo).toBeUndefined();
    }
  });
});

describe("shortcutProblems", () => {
  it("accepts the default shortcuts", () => {
    expect(SHORTCUT_DEFAULTS).toEqual({ omnibox: SHORTCUT_OMNIBOX_DEFAULT, newSummary: SHORTCUT_NEW_SUMMARY_DEFAULT, shortcutHelp: SHORTCUT_HELP_DEFAULT });
    expect(shortcutProblems(SHORTCUT_DEFAULTS)).toEqual({});
  });

  it("flags reserved keys, Ctrl+Alt (AltGr), bare keys and combinations shared by two actions", () => {
    expect(RESERVED_SHORTCUTS.has("Ctrl+W")).toBe(true);
    expect(shortcutProblems(effectiveShortcuts({ omnibox: "Ctrl+T" }))).toEqual({ omnibox: "reserved" });
    expect(shortcutProblems(effectiveShortcuts({ omnibox: "Ctrl+Shift+J" }))).toEqual({ omnibox: "reserved" });
    expect(shortcutProblems(effectiveShortcuts({ omnibox: "Ctrl+Alt+K" }))).toEqual({ omnibox: "reserved" });
    expect(shortcutProblems(effectiveShortcuts({ shortcutHelp: "K" }))).toEqual({ shortcutHelp: "invalid" });
    expect(shortcutProblems(effectiveShortcuts({ shortcutHelp: "F1" }))).toEqual({});
    expect(shortcutProblems(effectiveShortcuts({ newSummary: SHORTCUT_OMNIBOX_DEFAULT }))).toEqual({ omnibox: "duplicate", newSummary: "duplicate" });
  });

  it("lets overrides replace defaults action by action", () => {
    expect(effectiveShortcuts({ omnibox: "Alt+K" })).toEqual({ ...SHORTCUT_DEFAULTS, omnibox: "Alt+K" });
  });
});
