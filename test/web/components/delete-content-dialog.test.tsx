import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { LIST_PAGE_SIZE_DEFAULT } from "../../../src/shared/defaults.ts";
import type { ContentEvent } from "../../../src/web/api/content-events.ts";
import { useContentEvents } from "../../../src/web/api/context.tsx";
import { queryKeys } from "../../../src/web/api/queries.ts";
import { DeleteContentDialog } from "../../../src/web/components/delete-content-dialog.tsx";
import { noteKeys, useNoteGroups } from "../../../src/web/notes/queries.ts";
import { searchKeys } from "../../../src/web/search/search.ts";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";

/** Keeps the notes groups mounted (so an invalidation refetches), exposes the cache and records content events. */
function Probe(props: { onClient: (client: QueryClient) => void; events: ContentEvent[] }) {
  props.onClient(useQueryClient());
  const contentEvents = useContentEvents();
  const { events } = props;
  useEffect(() => contentEvents.subscribe((event) => void events.push(event)), [contentEvents, events]);
  useNoteGroups({ page: 1, pageSize: LIST_PAGE_SIZE_DEFAULT });
  return null;
}

describe("DeleteContentDialog", () => {
  it("says the Content moves to the trash for the retention period, keeping local files", async () => {
    mockApi({});
    renderApp(<DeleteContentDialog content={{ id: "c1", title: "第一讲" }} onOpenChange={() => undefined} />);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("「第一讲」将移到回收站，30 天后自动彻底删除，期间可在「回收站」恢复；本地原文件不会被删除。");
  });

  it("after moving to the trash hides the Content's notes, refreshes every view, announces it and keeps the dismissed cache card", async () => {
    const { calls } = mockApi({
      "DELETE /api/contents/c1": { status: 204 },
      "GET /api/notes/groups": { body: { items: [], total: 0 } },
    });
    let queryClient: QueryClient | undefined;
    const events: ContentEvent[] = [];
    localStorage.setItem("amber.cache.dismissed.c1", "task-1");
    const onOpenChange = vi.fn();
    const onDeleted = vi.fn();
    renderApp(
      <>
        <Probe onClient={(client) => (queryClient = client)} events={events} />
        <DeleteContentDialog content={{ id: "c1", title: "第一讲" }} onOpenChange={onOpenChange} onDeleted={onDeleted} />
      </>,
    );
    const groupReads = () => calls.filter((call) => call.path.startsWith("/api/notes/groups")).length;
    await waitFor(() => expect(groupReads()).toBe(1));
    queryClient?.setQueryData(queryKeys.content("c1"), { id: "c1" });
    queryClient?.setQueryData(noteKeys.content("c1"), { items: [] });
    queryClient?.setQueryData(noteKeys.content("c1", "rev-1"), { items: [] });
    queryClient?.setQueryData(noteKeys.content("c2"), { items: [] });
    for (const key of [queryKeys.contentsAll, queryKeys.collections, queryKeys.collection("k1"), searchKeys.query("x", "global"), [...queryKeys.trash, "list"]]) {
      queryClient?.setQueryData(key, { items: [] });
    }

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(calls.some((call) => call.method === "DELETE" && call.path === "/api/contents/c1")).toBe(true);
    expect(queryClient?.getQueryData(queryKeys.content("c1"))).toBeUndefined();
    expect(queryClient?.getQueryData(noteKeys.content("c1"))).toBeUndefined();
    expect(queryClient?.getQueryData(noteKeys.content("c1", "rev-1"))).toBeUndefined();
    expect(queryClient?.getQueryData(noteKeys.content("c2"))).toEqual({ items: [] });
    expect(groupReads()).toBe(2);
    for (const key of [queryKeys.contentsAll, queryKeys.collections, queryKeys.collection("k1"), searchKeys.query("x", "global"), [...queryKeys.trash, "list"]]) {
      expect(queryClient?.getQueryState(key)?.isInvalidated).toBe(true);
    }
    expect(events).toEqual([{ type: "trashed", contentId: "c1" }]);
    // A restore brings the Content back as it was, the closed cache card included.
    expect(localStorage.getItem("amber.cache.dismissed.c1")).toBe("task-1");
    localStorage.removeItem("amber.cache.dismissed.c1");
  });

  it("keeps the dialog open with the server's reason when the Content still has unfinished tasks", async () => {
    mockApi({
      "DELETE /api/contents/c1": {
        status: 409,
        body: { error: { class: "conflict", code: "conflict.tasks_unfinished", retryDisposition: "never", userMessage: "这条内容还有未结束的任务" } },
      },
    });
    const events: ContentEvent[] = [];
    const onOpenChange = vi.fn();
    renderApp(
      <>
        <Probe onClient={() => undefined} events={events} />
        <DeleteContentDialog content={{ id: "c1", title: "第一讲" }} onOpenChange={onOpenChange} />
      </>,
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    expect(await within(dialog).findByText("这条内容还有未结束的任务")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(events).toEqual([]);
  });
});
