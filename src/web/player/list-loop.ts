import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { API_PAGE_SIZE_MAX } from "../../shared/defaults.ts";
import { collectionDetailDtoSchema } from "../../shared/dto/collection.ts";
import { contentDetailDtoSchema, contentListDtoSchema, type ContentDetailDto } from "../../shared/dto/content.ts";
import type { ApiClient } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { queryKeys, queryString } from "../api/queries.ts";
import { useDesktop } from "../desktop/use-desktop.ts";
import { isTextEditableTarget } from "../ui/context-menu.tsx";
import { playbackAsset } from "./media-url.ts";

/** What the list loop did at the end of playback. */
export type AdvanceResult = "navigated" | "replay" | "stay";

/** Navigation state that carries the list a Content was opened from. */
export interface ListLoopEntry {
  collectionId?: string;
  autoplayLocal: boolean;
}

/** The `state` a link into a Content passes so the list loop follows that collection. */
export function listLoopState(entry: { collectionId?: string; autoplayLocal?: boolean }): ListLoopEntry {
  return { ...(entry.collectionId === undefined ? {} : { collectionId: entry.collectionId }), autoplayLocal: entry.autoplayLocal === true };
}

/** Reads a location state of unknown origin; anything malformed counts as absent. */
export function parseListLoopEntry(state: unknown): ListLoopEntry {
  if (typeof state !== "object" || state === null) return { autoplayLocal: false };
  const record = state as Record<string, unknown>;
  const collectionId = typeof record.collectionId === "string" && record.collectionId !== "" ? record.collectionId : undefined;
  return listLoopState({ ...(collectionId === undefined ? {} : { collectionId }), autoplayLocal: record.autoplayLocal === true });
}

/** The list-loop state of the current location. */
export function useListLoopEntry(): ListLoopEntry {
  return parseListLoopEntry(useLocation().state);
}

/** The collection a Content in several collections loops through, chosen in the settings menu. */
export interface LoopCollectionChoice {
  options: ReadonlyArray<{ id: string; name: string }>;
  value: string;
  choose(collectionId: string): void;
}

/** The collection the list loop follows: the one carried in, if still a membership, else the oldest. */
function loopCollectionId(content: ContentDetailDto, entryCollectionId: string | undefined): string | undefined {
  return (content.collections.find((collection) => collection.id === entryCollectionId) ?? content.collections[0])?.id;
}

/**
 * The choice offered only when the Content belongs to more than one collection. It lives in
 * the location state, the same place a link into the Content carries its collection, so the
 * next item keeps it and Back restores it.
 */
export function useLoopCollectionChoice(content: ContentDetailDto): LoopCollectionChoice | undefined {
  const location = useLocation();
  const navigate = useNavigate();
  const entry = parseListLoopEntry(location.state);
  const value = loopCollectionId(content, entry.collectionId);
  const { pathname, search, hash } = location;
  const choose = useCallback(
    (collectionId: string) => {
      void navigate({ pathname, search, hash }, { replace: true, state: listLoopState({ collectionId, autoplayLocal: entry.autoplayLocal }) });
    },
    [navigate, pathname, search, hash, entry.autoplayLocal],
  );
  if (content.collections.length < 2 || value === undefined) return undefined;
  return { options: content.collections.map(({ id, name }) => ({ id, name })), value, choose };
}

/** Typing must not be interrupted by a page change: with focus in a text field the list loop only pauses. */
function focusInEditable(): boolean {
  const active = document.activeElement;
  // The player's own range inputs (seek bar, volume) keep focus after a drag; only text
  // entry counts as typing.
  return active !== null && isTextEditableTarget(active);
}

interface LoopList {
  /** Set only for a collection list; the Recent list has no id to carry. */
  collectionId?: string;
  contentIds: string[];
}

async function collectionList(client: ApiClient, queryClient: QueryClient, collectionId: string): Promise<LoopList> {
  const detail = await queryClient.fetchQuery({
    queryKey: queryKeys.collection(collectionId),
    queryFn: () => client.get(`/api/collections/${encodeURIComponent(collectionId)}`, collectionDetailDtoSchema),
  });
  return { collectionId, contentIds: detail.items.map((item) => item.contentId) };
}

/**
 * The Recent list in full: every Content in no collection, in the order the API gives
 * (pinned first, then newest), the same as the sidebar. Paging stops at `total` or when a
 * page brings nothing new, so a misbehaving cursor cannot loop forever.
 */
async function recentList(client: ApiClient): Promise<LoopList> {
  const contentIds: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await client.get(`/api/contents${queryString({ uncollected: true, limit: API_PAGE_SIZE_MAX, cursor })}`, contentListDtoSchema);
    let added = 0;
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      contentIds.push(item.id);
      added += 1;
    }
    cursor = page.nextCursor;
    if (cursor === undefined || added === 0 || contentIds.length >= page.total) break;
  }
  return { contentIds };
}

/** Which list the Content plays through: its collection (the chosen one among several) or the Recent list. */
function listOf(content: ContentDetailDto, entryCollectionId: string | undefined, client: ApiClient, queryClient: QueryClient): Promise<LoopList> {
  const collectionId = loopCollectionId(content, entryCollectionId);
  return collectionId === undefined ? recentList(client) : collectionList(client, queryClient, collectionId);
}

/** The items after `index`, wrapping round to the ones before it; the item itself is left out. */
function followingIds(ids: readonly string[], currentId: string, index: number): string[] {
  return [...ids.slice(index + 1), ...ids.slice(0, index)].filter((id) => id !== currentId);
}

/**
 * Moves to the next locally playable Content of the list `content` belongs to.
 * Candidates are judged from this backend's own Content details, so no platform is
 * contacted. The returned function never rejects: any failure answers "replay".
 */
export function usePlaylistAdvance(content: ContentDetailDto): () => Promise<AdvanceResult> {
  const client = useApi();
  const queryClient = useQueryClient();
  const desktop = useDesktop();
  const navigate = useNavigate();
  const entry = useListLoopEntry();
  const entryCollectionId = entry.collectionId;
  // A search still running when the page moves on must not navigate away from the new page.
  const currentId = useRef<string | undefined>(content.id);
  useEffect(() => {
    currentId.current = content.id;
    return () => {
      currentId.current = undefined;
    };
  }, [content.id]);

  return useCallback(async (): Promise<AdvanceResult> => {
    if (focusInEditable()) return "stay";
    const startedOn = content.id;
    const stillHere = (): boolean => currentId.current === startedOn;
    try {
      const list = await listOf(content, entryCollectionId, client, queryClient);
      const index = list.contentIds.indexOf(content.id);
      if (index < 0) return "replay";
      for (const candidateId of followingIds(list.contentIds, content.id, index)) {
        if (!stillHere()) return "stay";
        let detail: ContentDetailDto;
        try {
          detail = await queryClient.fetchQuery({
            queryKey: queryKeys.content(candidateId),
            queryFn: () => client.get(`/api/contents/${encodeURIComponent(candidateId)}`, contentDetailDtoSchema),
          });
        } catch {
          // A member that cannot be read (e.g. deleted meanwhile) is passed over.
          continue;
        }
        if (playbackAsset(detail, client.mode, desktop) === undefined) continue;
        if (!stillHere() || focusInEditable()) return "stay";
        void navigate(`/contents/${encodeURIComponent(candidateId)}`, {
          state: listLoopState({ ...(list.collectionId === undefined ? {} : { collectionId: list.collectionId }), autoplayLocal: true }),
        });
        return "navigated";
      }
      return "replay";
    } catch {
      return "replay";
    }
  }, [content, entryCollectionId, client, queryClient, desktop, navigate]);
}
