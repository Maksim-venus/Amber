import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ContentDetailDto, MediaAssetDto } from "../../../src/shared/dto/content.ts";
import type { RunMode } from "../../../src/shared/enums.ts";
import { ApiClient } from "../../../src/web/api/client.ts";
import { ApiProvider, createQueryClient } from "../../../src/web/api/context.tsx";
import { useDesktop } from "../../../src/web/desktop/use-desktop.ts";
import { listLoopState, parseListLoopEntry, useLoopCollectionChoice, usePlaylistAdvance, type AdvanceResult, type LoopCollectionChoice } from "../../../src/web/player/list-loop.ts";
import { contentDetail } from "../../fixtures/web/content-data.ts";
import { fakeShell } from "../../fixtures/web/desktop-bridge.ts";
import { mockApi, type RecordedCall } from "../../fixtures/web/render.tsx";
import { collectionDetail, content } from "../../fixtures/web/shell-data.ts";

vi.mock("../../../src/web/desktop/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("../../fixtures/web/desktop-bridge.ts")).fakeBridge,
}));

const CACHE: MediaAssetDto = { id: "m", kind: "platform_cache", mimeType: "video/mp4", sizeBytes: 1, availability: "available", retentionPolicy: "evictable", createdAt: 1 };

/** A Content detail; `playable` gives it a cache the server mode streams. */
function detail(id: string, playable: boolean, collections: ContentDetailDto["collections"] = []): ContentDetailDto {
  return contentDetail({ id, collections, media: playable ? [{ ...CACHE, id: `m-${id}` }] : [] });
}

function membership(id: string) {
  return { id, name: `合集 ${id}`, itemId: `item-${id}` };
}

function detailRoutes(details: readonly ContentDetailDto[]) {
  return Object.fromEntries(details.map((item) => [`GET /api/contents/${item.id}`, { body: item }]));
}

const handle: { advance?: () => Promise<AdvanceResult>; desktop?: boolean; choice?: LoopCollectionChoice | undefined } = {};

function Probe(props: { content: ContentDetailDto }) {
  handle.advance = usePlaylistAdvance(props.content);
  handle.desktop = useDesktop();
  handle.choice = useLoopCollectionChoice(props.content);
  const location = useLocation();
  return (
    <div>
      <div data-testid="where">{location.pathname}</div>
      <div data-testid="state">{JSON.stringify(location.state ?? null)}</div>
      <textarea data-testid="chat-input" />
    </div>
  );
}

function setup(current: ContentDetailDto, routes: Parameters<typeof mockApi>[0], options: { state?: unknown; mode?: RunMode } = {}): { calls: RecordedCall[] } {
  const api = mockApi(routes);
  render(
    <ApiProvider client={new ApiClient({ baseUrl: "" }, options.mode ?? "server")} queryClient={createQueryClient()}>
      <MemoryRouter initialEntries={[{ pathname: `/contents/${current.id}`, state: options.state }]}>
        <Routes>
          <Route path="/contents/:id" element={<Probe content={current} />} />
        </Routes>
      </MemoryRouter>
    </ApiProvider>,
  );
  return api;
}

async function advance(): Promise<AdvanceResult> {
  let result: AdvanceResult | undefined;
  await act(async () => {
    result = await handle.advance?.();
  });
  if (result === undefined) throw new Error("advance not ready");
  return result;
}

function landedOn(): { path: string; state: unknown } {
  return { path: screen.getByTestId("where").textContent ?? "", state: JSON.parse(screen.getByTestId("state").textContent ?? "null") };
}

describe("parseListLoopEntry", () => {
  it("keeps a collection id and the autoplay flag and drops anything malformed", () => {
    expect(parseListLoopEntry({ collectionId: "col1", autoplayLocal: true })).toEqual({ collectionId: "col1", autoplayLocal: true });
    expect(parseListLoopEntry({ autoplayLocal: true })).toEqual({ autoplayLocal: true });
    expect(parseListLoopEntry({ collectionId: 7, autoplayLocal: "yes" })).toEqual({ autoplayLocal: false });
    expect(parseListLoopEntry({ collectionId: "" })).toEqual({ autoplayLocal: false });
    expect(parseListLoopEntry(null)).toEqual({ autoplayLocal: false });
    expect(parseListLoopEntry("col1")).toEqual({ autoplayLocal: false });
    expect(listLoopState({ collectionId: "col1" })).toEqual({ collectionId: "col1", autoplayLocal: false });
  });
});

describe("usePlaylistAdvance", () => {
  it("follows the collection it was opened from while it still holds the Content", async () => {
    const current = detail("c1", true, [membership("colA"), membership("colB")]);
    const { calls } = setup(
      current,
      {
        "GET /api/collections/colA": { body: collectionDetail("colA", "A", ["c1", "a2"]) },
        "GET /api/collections/colB": { body: collectionDetail("colB", "B", ["b0", "c1", "b2"]) },
        ...detailRoutes([detail("a2", true), detail("b0", true), detail("b2", true)]),
      },
      { state: { collectionId: "colB", autoplayLocal: false } },
    );
    expect(await advance()).toBe("navigated");
    expect(landedOn()).toEqual({ path: "/contents/b2", state: { collectionId: "colB", autoplayLocal: true } });
    expect(calls.some((call) => call.path === "/api/collections/colA")).toBe(false);
  });

  it("uses the oldest collection when the entry's collection no longer holds the Content", async () => {
    const current = detail("c1", true, [membership("colA"), membership("colB")]);
    setup(
      current,
      {
        "GET /api/collections/colA": { body: collectionDetail("colA", "A", ["c1", "a2"]) },
        ...detailRoutes([detail("a2", true)]),
      },
      { state: { collectionId: "gone", autoplayLocal: true } },
    );
    expect(await advance()).toBe("navigated");
    expect(landedOn()).toEqual({ path: "/contents/a2", state: { collectionId: "colA", autoplayLocal: true } });
  });

  it("plays through the whole Recent list across pages, skipping what cannot play, without a collection id", async () => {
    const current = detail("c1", true);
    const { calls } = setup(current, {
      "GET /api/contents": (call) =>
        call.path.includes("cursor=p2")
          ? { body: { items: [content("r3"), content("r4")], total: 4 } }
          : { body: { items: [content("r1"), content("c1")], total: 4, nextCursor: "p2" } },
      ...detailRoutes([detail("r1", true), detail("r3", false), detail("r4", true)]),
    });
    expect(await advance()).toBe("navigated");
    expect(landedOn()).toEqual({ path: "/contents/r4", state: { autoplayLocal: true } });
    const pages = calls.filter((call) => call.path.startsWith("/api/contents?"));
    expect(pages).toHaveLength(2);
    expect(pages.every((call) => new URLSearchParams(call.path.split("?")[1]).get("uncollected") === "1")).toBe(true);
    expect(calls.some((call) => call.path === "/api/contents/r3")).toBe(true);
    expect(calls.some((call) => call.path === "/api/contents/r1")).toBe(false);
  });

  it("wraps from the end of the list back to its start", async () => {
    const current = detail("c1", true);
    setup(current, {
      "GET /api/contents": (call) =>
        call.path.includes("cursor=p2") ? { body: { items: [content("r3"), content("c1")], total: 4 } } : { body: { items: [content("r1"), content("r2")], total: 4, nextCursor: "p2" } },
      ...detailRoutes([detail("r1", false), detail("r2", true), detail("r3", false)]),
    });
    expect(await advance()).toBe("navigated");
    expect(landedOn().path).toBe("/contents/r2");
  });

  it("passes over members that cannot be read", async () => {
    const current = detail("c1", true, [membership("colA")]);
    setup(current, {
      "GET /api/collections/colA": { body: collectionDetail("colA", "A", ["c1", "deleted", "a3"]) },
      ...detailRoutes([detail("a3", true)]),
    });
    expect(await advance()).toBe("navigated");
    expect(landedOn().path).toBe("/contents/a3");
  });

  it("replays when nothing else in the list can play locally", async () => {
    const current = detail("c1", true, [membership("colA")]);
    setup(current, {
      "GET /api/collections/colA": { body: collectionDetail("colA", "A", ["a0", "c1", "a2"]) },
      ...detailRoutes([detail("a0", false), detail("a2", false)]),
    });
    expect(await advance()).toBe("replay");
    expect(landedOn().path).toBe("/contents/c1");
  });

  it("replays when the list cannot be read or does not hold the Content", async () => {
    setup(detail("c1", true, [membership("colA")]), {});
    expect(await advance()).toBe("replay");
  });

  it("replays when the current Content is missing from its list", async () => {
    setup(detail("c1", true, [membership("colA")]), {
      "GET /api/collections/colA": { body: collectionDetail("colA", "A", ["a0", "a2"]) },
      ...detailRoutes([detail("a0", true), detail("a2", true)]),
    });
    expect(await advance()).toBe("replay");
    expect(landedOn().path).toBe("/contents/c1");
  });

  it("stays put while the user types in a text field", async () => {
    const { calls } = setup(detail("c1", true, [membership("colA")]), {
      "GET /api/collections/colA": { body: collectionDetail("colA", "A", ["c1", "a2"]) },
      ...detailRoutes([detail("a2", true)]),
    });
    screen.getByTestId("chat-input").focus();
    expect(await advance()).toBe("stay");
    expect(calls).toHaveLength(0);
    expect(landedOn().path).toBe("/contents/c1");
  });

  it("judges local playability in the desktop client by its local files", async () => {
    fakeShell.desktop = true;
    // An original the backend reports without a path (e.g. missing on this computer) cannot play.
    const pathless: MediaAssetDto = { ...CACHE, id: "g", kind: "external_local", retentionPolicy: "never_delete" };
    const local: MediaAssetDto = { ...pathless, id: "f", localPath: "D:\\课程\\a.mp4" };
    const current = detail("c1", false, [membership("colA")]);
    setup(
      current,
      {
        "GET /api/collections/colA": { body: collectionDetail("colA", "A", ["c1", "a2", "a3"]) },
        ...detailRoutes([{ ...detail("a2", false), media: [pathless] }, { ...detail("a3", false), media: [local] }]),
      },
      { mode: "local" },
    );
    await waitFor(() => expect(handle.desktop).toBe(true));
    expect(await advance()).toBe("navigated");
    expect(landedOn().path).toBe("/contents/a3");
  });
});

describe("useLoopCollectionChoice", () => {
  it("offers no choice to a Content in one collection or none", () => {
    setup(detail("c1", true, [membership("colA")]), {});
    expect(handle.choice).toBeUndefined();
  });

  it("offers every collection of a Content in several, preselecting the one it was opened from, else the oldest", () => {
    const current = detail("c1", true, [membership("colA"), membership("colB")]);
    setup(current, {}, { state: { collectionId: "colB", autoplayLocal: false } });
    expect(handle.choice?.options).toEqual([
      { id: "colA", name: "合集 colA" },
      { id: "colB", name: "合集 colB" },
    ]);
    expect(handle.choice?.value).toBe("colB");
  });

  it("defaults to the oldest collection when opened directly", () => {
    setup(detail("c1", true, [membership("colA"), membership("colB")]), {});
    expect(handle.choice?.value).toBe("colA");
  });

  it("keeps the chosen collection in the location state, and the loop then plays through it", async () => {
    const current = detail("c1", true, [membership("colA"), membership("colB")]);
    const { calls } = setup(
      current,
      {
        "GET /api/collections/colA": { body: collectionDetail("colA", "A", ["c1", "a2"]) },
        "GET /api/collections/colB": { body: collectionDetail("colB", "B", ["b0", "c1"]) },
        ...detailRoutes([detail("a2", true), detail("b0", true)]),
      },
      { state: { autoplayLocal: true } },
    );
    act(() => handle.choice?.choose("colB"));
    expect(landedOn()).toEqual({ path: "/contents/c1", state: { collectionId: "colB", autoplayLocal: true } });
    expect(handle.choice?.value).toBe("colB");
    expect(await advance()).toBe("navigated");
    // Past the last item the loop wraps round to the first of the chosen collection.
    expect(landedOn()).toEqual({ path: "/contents/b0", state: { collectionId: "colB", autoplayLocal: true } });
    expect(calls.some((call) => call.path === "/api/collections/colA")).toBe(false);
  });
});
