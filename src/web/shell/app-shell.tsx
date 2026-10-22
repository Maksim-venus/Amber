import { useState } from "react";
import { Outlet, useNavigate } from "react-router";
import { usePatchSettings, useSettings } from "../api/queries.ts";
import type { CommandContext } from "../commands.ts";
import { useTaskNotifications } from "../desktop/task-notifications.ts";
import { SidebarWidthProvider } from "../layout-width.tsx";
import { DESKTOP_BLOCKED_BROWSER_KEYS } from "../../shared/shortcuts.ts";
import { useDesktop } from "../desktop/use-desktop.ts";
import { useBlockedKeys, useShortcut } from "../shortcut-registry.tsx";
import { useContentEventSync } from "./content-sync.ts";
import { Omnibox } from "./omnibox.tsx";
import { usePasteGuard } from "./paste-guard.ts";
import { ShortcutHelp } from "./shortcut-help.tsx";
import { Sidebar } from "./sidebar.tsx";
import { TaskPanel } from "./task-panel.tsx";
import { nextTheme } from "./theme.ts";

/** Left column + routed page; overlays (Omnibox, tasks, shortcut table) hang off the shell. */
export function AppShell() {
  const navigate = useNavigate();
  const settings = useSettings();
  const patchSettings = usePatchSettings();
  const [omnibox, setOmnibox] = useState(false);
  const [tasks, setTasks] = useState(false);
  const [help, setHelp] = useState(false);

  const context: CommandContext = {
    navigate: (path) => void navigate(path),
    toggleTheme: () => patchSettings.mutate({ theme: nextTheme(settings.data?.theme) }),
    openShortcutHelp: () => setHelp(true),
  };
  useShortcut("omnibox", () => setOmnibox(true));
  useShortcut("newSummary", () => void navigate("/new"));
  useShortcut("shortcutHelp", () => setHelp(true));
  usePasteGuard();
  useBlockedKeys(DESKTOP_BLOCKED_BROWSER_KEYS, useDesktop());
  useTaskNotifications();
  useContentEventSync();

  return (
    <SidebarWidthProvider>
      <div className="flex h-full">
        <Sidebar onOpenOmnibox={() => setOmnibox(true)} onOpenTasks={() => setTasks(true)} />
        <main className="min-w-0 flex-1 overflow-auto">
          <Outlet />
        </main>
        <Omnibox open={omnibox} onOpenChange={setOmnibox} context={context} />
        <TaskPanel open={tasks} onOpenChange={setTasks} />
        <ShortcutHelp open={help} onOpenChange={setHelp} />
      </div>
    </SidebarWidthProvider>
  );
}
