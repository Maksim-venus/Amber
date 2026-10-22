import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useContentEvents } from "../api/context.tsx";
import { forgetContent, refreshContentViews } from "../api/content-events.ts";
import { queryKeys } from "../api/queries.ts";

/**
 * Follows trash changes made in the user's other tabs: this tab's lists, collections, notes,
 * search and trash are read again, and a Content that is no longer readable is forgotten.
 * Changes made in this tab were refreshed by whoever made them.
 */
export function useContentEventSync(): void {
  const contentEvents = useContentEvents();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      contentEvents.subscribe((event, origin) => {
        if (!origin.remote) return;
        if (event.type === "trashed" || event.type === "purged") {
          void forgetContent(queryClient, event.contentId);
        }
        void refreshContentViews(queryClient);
        // Its tasks leave (or rejoin) the task lists, unfinished and finished alike, with it.
        void queryClient.invalidateQueries({ queryKey: queryKeys.tasksAll });
      }),
    [contentEvents, queryClient],
  );
}
