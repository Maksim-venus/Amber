import type { ShortcutAction } from "../shared/shortcuts.ts";

/** What a command may do; the shell provides it. */
export interface CommandContext {
  navigate(path: string): void;
  toggleTheme(): void;
  openShortcutHelp(): void;
}

/**
 * One entry of the command registry: data, not handlers scattered across
 * components, so the Omnibox, shortcut help and later an agent tool list read one table.
 * `titleKey` is an i18n key; `shortcut` names the bound action when there is one.
 */
export interface Command {
  id: string;
  titleKey: CommandTitleKey;
  shortcut?: ShortcutAction;
  run(context: CommandContext): void;
}

export type CommandTitleKey =
  | "common.nav.newSummary"
  | "common.nav.library"
  | "common.nav.collections"
  | "common.nav.notes"
  | "common.nav.trash"
  | "common.nav.settings"
  | "common.theme.toggle"
  | "common.shortcut.shortcutHelp";

export const COMMANDS: readonly Command[] = [
  { id: "new-summary", titleKey: "common.nav.newSummary", shortcut: "newSummary", run: (context) => context.navigate("/new") },
  { id: "open-library", titleKey: "common.nav.library", run: (context) => context.navigate("/library") },
  { id: "open-collections", titleKey: "common.nav.collections", run: (context) => context.navigate("/collections") },
  { id: "open-notes", titleKey: "common.nav.notes", run: (context) => context.navigate("/notes") },
  { id: "open-trash", titleKey: "common.nav.trash", run: (context) => context.navigate("/trash") },
  { id: "open-settings", titleKey: "common.nav.settings", run: (context) => context.navigate("/settings/models") },
  { id: "toggle-theme", titleKey: "common.theme.toggle", run: (context) => context.toggleTheme() },
  { id: "shortcut-help", titleKey: "common.shortcut.shortcutHelp", shortcut: "shortcutHelp", run: (context) => context.openShortcutHelp() },
];
