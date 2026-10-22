import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { TRASH_RETENTION_DAYS } from "../../shared/defaults.ts";
import { useApi, useContentEvents } from "../api/context.tsx";
import { refreshContentViews } from "../api/content-events.ts";
import { queryKeys } from "../api/queries.ts";
import { noteKeys } from "../notes/note-keys.ts";
import { ConfirmDialog } from "./confirm-dialog.tsx";

/**
 * Confirms and performs `DELETE /api/contents/:id`, which moves the Content to the trash,
 * from the library list or the content page. A Content with unfinished
 * tasks is refused by the server and the reason stays in the dialog.
 */
export function DeleteContentDialog(props: {
  content: { id: string; title?: string } | undefined;
  onOpenChange: (open: boolean) => void;
  /** Runs once the deletion succeeded, before the caches are cleared and the lists refresh. */
  onDeleted?: () => void;
}) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const contentEvents = useContentEvents();
  const { content } = props;
  return (
    <ConfirmDialog
      open={content !== undefined}
      onOpenChange={props.onOpenChange}
      title={t("library.deleteContent.title")}
      description={t("library.deleteContent.description", { title: content?.title ?? t("library.untitled"), days: TRASH_RETENTION_DAYS })}
      confirmLabel={t("common.action.delete")}
      danger
      onConfirm={async () => {
        if (content === undefined) {
          return;
        }
        await client.delete(`/api/contents/${encodeURIComponent(content.id)}`, z.undefined());
        props.onDeleted?.();
        // A trashed Content answers 404 everywhere; a refetch would only show that.
        queryClient.removeQueries({ queryKey: queryKeys.content(content.id) });
        // Its notes are hidden with it; the groups list loses its row. The dismissed cache
        // card is kept: a restore brings the Content back exactly as it was.
        queryClient.removeQueries({ queryKey: noteKeys.contentAll(content.id) });
        contentEvents.publish({ type: "trashed", contentId: content.id });
        await refreshContentViews(queryClient);
      }}
    />
  );
}
