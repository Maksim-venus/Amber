import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NoteDto, NoteGroupDto } from "../../../src/shared/dto/note.ts";
import { formatDateTime } from "../../../src/web/format.ts";
import { NotesPage } from "../../../src/web/pages/notes-page.tsx";
import { content } from "../../fixtures/web/shell-data.ts";
import { mockApi, renderApp, type RecordedCall } from "../../fixtures/web/render.tsx";

// Synthetic notes; ids and times only need to be distinct.
function note(id: string, contentId: string, overrides: Partial<NoteDto> = {}): NoteDto {
  return {
    id,
    contentId,
    contentTitle: `内容 ${contentId}`,
    transcriptRevisionId: `rev-${contentId}`,
    startSegmentId: `seg-${id}`,
    startOffset: 0,
    endSegmentId: `seg-${id}`,
    endOffset: 4,
    startMs: 65_000,
    quote: `摘录 ${id}`,
    mark: "background",
    color: "yellow",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function group(contentId: string, count: number, latestAt = 1): NoteGroupDto {
  return { contentId, title: `内容 ${contentId}`, count, latestAt };
}

const notesOf = (...items: NoteDto[]) => ({ body: { items } });

/** Answers one numbered page of `groups` the way the server does. */
function pagedGroups(groups: NoteGroupDto[]) {
  return (call: RecordedCall) => {
    const query = new URL(call.path, "http://localhost").searchParams;
    const limit = Number(query.get("limit"));
    const at = (Number(query.get("page")) - 1) * limit;
    return { body: { items: groups.slice(at, at + limit), total: groups.length } };
  };
}

const groupIds = () => screen.getAllByTestId("notes-group").map((element) => element.getAttribute("data-content-id"));
const expandedIds = () =>
  screen
    .getAllByTestId("notes-group")
    .filter((element) => within(element).getByTestId("notes-group-toggle").getAttribute("aria-expanded") === "true")
    .map((element) => element.getAttribute("data-content-id"));
const groupOf = (contentId: string) => screen.getAllByTestId("notes-group").find((element) => element.getAttribute("data-content-id") === contentId) as HTMLElement;

afterEach(() => {
  localStorage.clear();
});
const NOT_FOUND = { status: 404, body: { error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "内容不存在" } } };

describe("NotesPage", () => {
  it("lists groups latest first with count and time, the first one expanded with its notes", async () => {
    const latestAt = Date.UTC(2026, 9, 8, 9, 15);
    const { calls } = mockApi({
      "GET /api/notes/groups": { body: { items: [group("c1", 2, latestAt), group("c2", 1)], total: 2 } },
      "GET /api/contents/c1/notes": notesOf(note("n1", "c1"), note("n2", "c1")),
      "GET /api/contents/c2/notes": notesOf(note("n3", "c2")),
    });
    renderApp(<NotesPage />, { route: "/notes", path: "/notes" });
    expect((await screen.findByTestId("notes-summary")).textContent).toBe("2 个内容有笔记");
    const groups = screen.getAllByTestId("notes-group");
    expect(groups).toHaveLength(2);
    const [first, second] = groups as [HTMLElement, HTMLElement];
    expect(within(first).getByRole("link", { name: "内容 c1" }).getAttribute("href")).toBe("/contents/c1");
    expect(first.textContent).toContain(`2 条 · 最近 ${formatDateTime(latestAt, "zh-CN")}`);
    expect(within(first).getByTestId("notes-group-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(within(second).getByTestId("notes-group-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(await within(first).findAllByTestId("note-card")).toHaveLength(2);
    expect(within(second).queryByTestId("note-card")).toBeNull();
    // A collapsed group's notes are not fetched; the list carries no revision.
    expect(calls.some((call) => call.path.startsWith("/api/contents/c2/notes"))).toBe(false);
    expect(calls.find((call) => call.path.startsWith("/api/contents/c1/notes"))?.path).toBe("/api/contents/c1/notes");
    fireEvent.click(within(second).getByTestId("notes-group-toggle"));
    expect(await within(second).findAllByTestId("note-card")).toHaveLength(1);
    fireEvent.click(within(first).getByTestId("notes-group-toggle"));
    expect(within(first).queryByTestId("note-card")).toBeNull();
  });

  it("links each note to its anchor sentence in the anchored revision", async () => {
    mockApi({
      "GET /api/notes/groups": { body: { items: [group("c1", 1)], total: 1 } },
      "GET /api/contents/c1/notes": notesOf(note("n1", "c1")),
    });
    renderApp(<NotesPage />, { route: "/notes", path: "/notes" });
    const card = await screen.findByTestId("note-card");
    const href = within(card).getByRole("link", { name: "定位原文" }).getAttribute("href") ?? "";
    const url = new URL(href, "http://localhost");
    expect(url.pathname).toBe("/contents/c1");
    expect(Object.fromEntries(url.searchParams)).toEqual({ tab: "transcript", revision: "rev-c1", segment: "seg-n1" });
  });

  it("shows what the user wrote: no mark or colour controls, the comment action beside 定位原文", async () => {
    const { calls } = mockApi({
      "GET /api/notes/groups": { body: { items: [group("c1", 2)], total: 1 } },
      "GET /api/contents/c1/notes": notesOf(note("n1", "c1"), note("n2", "c1", { comment: "已有评论" })),
      "PATCH /api/notes/n1": (call: RecordedCall) => ({ body: note("n1", "c1", { comment: (call.body as { comment: string }).comment }) }),
    });
    renderApp(<NotesPage />, { route: "/notes", path: "/notes" });
    const [plain, commented] = (await screen.findAllByTestId("note-card")) as [HTMLElement, HTMLElement];
    for (const card of [plain, commented]) {
      expect(within(card).queryByRole("group", { name: "标记" })).toBeNull();
      expect(within(card).queryByTestId("note-mark-underline")).toBeNull();
      expect(within(card).queryByTestId("note-color-yellow")).toBeNull();
      // The comment action shares the foot row with 定位原文.
      const foot = within(card).getByTestId("note-locate").parentElement as HTMLElement;
      expect(within(foot).getByTestId("note-comment-edit")).toBeTruthy();
    }
    expect(within(plain).getByTestId("note-comment-edit").textContent).toBe("添加评论");
    expect(within(commented).getByTestId("note-comment").textContent).toBe("已有评论");
    expect(within(commented).getByTestId("note-comment-edit").textContent).toBe("编辑评论");
    fireEvent.click(within(plain).getByTestId("note-comment-edit"));
    expect(within(plain).queryByTestId("note-comment-edit")).toBeNull();
    fireEvent.change(within(plain).getByTestId("note-comment-input"), { target: { value: "新评论" } });
    fireEvent.click(within(plain).getByTestId("note-comment-save"));
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ comment: "新评论" }));
  });

  it("pages the groups: each page opens its first group, explicit toggles outlive page changes, expand all acts on this page only", async () => {
    const all = Array.from({ length: 12 }, (_, index) => group(`c${index + 1}`, 1));
    const routes: Parameters<typeof mockApi>[0] = { "GET /api/notes/groups": pagedGroups(all) };
    for (const { contentId } of all) routes[`GET /api/contents/${contentId}/notes`] = notesOf(note(`n-${contentId}`, contentId));
    const { calls } = mockApi(routes);
    renderApp(<NotesPage />, { route: "/notes", path: "/notes" });
    await waitFor(() => expect(groupIds()).toHaveLength(10));
    expect(screen.getByTestId("notes-summary").textContent).toBe("12 个内容有笔记");
    expect(screen.queryByText("加载更多")).toBeNull();
    expect(expandedIds()).toEqual(["c1"]);
    // An explicit collapse of the first group.
    fireEvent.click(within(groupOf("c1")).getByTestId("notes-group-toggle"));
    expect(expandedIds()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(groupIds()).toEqual(["c11", "c12"]));
    const groupReads = calls.filter((call) => call.path.startsWith("/api/notes/groups")).map((call) => call.path);
    expect(groupReads).toEqual(["/api/notes/groups?limit=10&page=1", "/api/notes/groups?limit=10&page=2"]);
    expect(screen.getByTestId("notes-summary").textContent).toBe("12 个内容有笔记");
    expect(expandedIds()).toEqual(["c11"]);
    const expandAll = screen.getByTestId("notes-expand-all");
    expect(expandAll.textContent).toBe("全部展开");
    fireEvent.click(expandAll);
    expect(expandedIds()).toEqual(["c11", "c12"]);
    expect(screen.getByTestId("notes-expand-all").textContent).toBe("全部收起");

    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    await waitFor(() => expect(groupIds()).toHaveLength(10));
    // c1 stays collapsed as toggled; expand all on page 2 left this page alone.
    expect(expandedIds()).toEqual([]);
    expect(screen.getByTestId("notes-expand-all").textContent).toBe("全部展开");
    fireEvent.click(screen.getByTestId("notes-expand-all"));
    expect(expandedIds()).toEqual(all.slice(0, 10).map((item) => item.contentId));
    fireEvent.click(screen.getByTestId("notes-expand-all"));
    expect(expandedIds()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(groupIds()).toEqual(["c11", "c12"]));
    expect(expandedIds()).toEqual(["c11", "c12"]);
  });

  it("shows loading, not the previous page's groups, while the next page is on its way", async () => {
    const all = Array.from({ length: 12 }, (_, index) => group(`c${index + 1}`, 1));
    mockApi({ "GET /api/notes/groups": pagedGroups(all), "GET /api/contents/c1/notes": notesOf(note("n1", "c1")) });
    const answered = globalThis.fetch;
    let release: (() => void) | undefined;
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) =>
      String(input).includes("page=2") ? new Promise<Response>((resolve) => (release = () => resolve(answered(input, init)))) : answered(input, init),
    );
    renderApp(<NotesPage />, { route: "/notes", path: "/notes" });
    await waitFor(() => expect(groupIds()).toHaveLength(10));
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(release).toBeDefined());
    expect(screen.queryAllByTestId("notes-group")).toHaveLength(0);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("第 2 / 2 页")).toBeTruthy();
    release?.();
    await waitFor(() => expect(groupIds()).toEqual(["c11", "c12"]));
  });

  it("shows the empty state when there are no notes", async () => {
    mockApi({ "GET /api/notes/groups": { body: { items: [], total: 0 } } });
    renderApp(<NotesPage />, { route: "/notes", path: "/notes" });
    expect(await screen.findByText("还没有笔记")).toBeTruthy();
    expect(screen.getByText("在原文细读里选中文字，就可以加下划线、高亮或评论")).toBeTruthy();
    expect(screen.queryByTestId("notes-expand-all")).toBeNull();
  });

  it("narrows to one Content titled from its detail, and clears the filter on 查看全部", async () => {
    const { calls } = mockApi({
      "GET /api/contents/c9": { body: { ...content("c9", { title: "改过的标题", customTitle: "改过的标题" }), media: [] } },
      "GET /api/contents/c9/notes": notesOf(note("n1", "c9", { createdAt: 5 }), note("n2", "c9", { createdAt: 9 })),
      "GET /api/notes/groups": { body: { items: [group("c1", 1)], total: 1 } },
      "GET /api/contents/c1/notes": notesOf(note("n3", "c1")),
    });
    renderApp(<NotesPage />, { route: "/notes?contentId=c9", path: "/notes" });
    const only = await screen.findByTestId("notes-group");
    expect(within(only).getByRole("link", { name: "改过的标题" }).getAttribute("href")).toBe("/contents/c9");
    expect(only.textContent).toContain(`2 条 · 最近 ${formatDateTime(9, "zh-CN")}`);
    expect(within(only).getByTestId("notes-group-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(await within(only).findAllByTestId("note-card")).toHaveLength(2);
    expect(calls.some((call) => call.path.startsWith("/api/notes/groups"))).toBe(false);

    fireEvent.click(screen.getByTestId("notes-view-all"));
    await waitFor(() => expect(screen.getByTestId("notes-group").getAttribute("data-content-id")).toBe("c1"));
    expect(screen.getByTestId("notes-summary").textContent).toBe("1 个内容有笔记");
  });

  it("shows a Content without notes as an empty state, still titled", async () => {
    mockApi({
      "GET /api/contents/c9": { body: { ...content("c9", { title: "第一讲" }), media: [] } },
      "GET /api/contents/c9/notes": notesOf(),
    });
    renderApp(<NotesPage />, { route: "/notes?contentId=c9", path: "/notes" });
    expect(await screen.findByText("这条内容还没有笔记")).toBeTruthy();
    expect(screen.getByRole("link", { name: "第一讲" }).getAttribute("href")).toBe("/contents/c9");
    expect(screen.queryByTestId("notes-group")).toBeNull();
    expect(screen.getByTestId("notes-view-all").textContent).toBe("查看全部");
  });

  it("reports a missing Content through the error view", async () => {
    mockApi({ "GET /api/contents/gone": NOT_FOUND, "GET /api/contents/gone/notes": NOT_FOUND });
    renderApp(<NotesPage />, { route: "/notes?contentId=gone", path: "/notes" });
    expect((await screen.findByRole("alert")).textContent).toContain("内容不存在");
    expect(screen.queryByTestId("notes-group")).toBeNull();
    expect(screen.queryByText("这条内容还没有笔记")).toBeNull();
  });
});
