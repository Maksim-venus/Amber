import { DropdownMenu } from "radix-ui";
import { MoreHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MenuEntries } from "../ui/context-menu.tsx";
import type { ContentActions, ContentActionTarget } from "./use-content-actions.tsx";

/**
 * The 「⋯」 menu of a Content row: the `overflow` actions of
 * `useContentActions`. The row owns the hook and renders its dialogs once, so this menu and
 * the row's right-click menu share them. The trigger shows on hover or focus; touch screens,
 * which cannot hover, always show it.
 */
export function ContentRowMenu(props: { actions: ContentActions; content: ContentActionTarget; label: string; className?: string }) {
  const { t } = useTranslation();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label={t("shell.sidebar.recentMore", { title: props.label })}
        className={`flex size-6 items-center justify-center rounded text-muted opacity-0 group-hover:opacity-100 hover:bg-line focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100 ${props.className ?? ""}`}
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side="right" align="start" sideOffset={4} className="z-50 min-w-36 rounded-md border border-line bg-surface p-1 text-sm shadow-lg">
          <MenuEntries entries={props.actions.entries("overflow", props.content)} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
