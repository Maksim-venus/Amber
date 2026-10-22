import type { Request, Route } from "@playwright/test";
import { contentDtoSchema, type ContentDto } from "../../src/shared/dto/content.ts";
import { trashItemDtoSchema, trashListDtoSchema, trashPurgeAllDtoSchema, type TrashItemDto } from "../../src/shared/dto/trash.ts";
import { API_PAGE_SIZE_DEFAULT, TRASH_RETENTION_DAYS } from "../../src/shared/defaults.ts";
import { ERROR_CLASS_DEFAULTS, errorResponseSchema, type ErrorClass } from "../../src/shared/errors.ts";

/*
 * The trash of the fake backend. Deleting a Content only moves it here: it leaves the
 * listings, and every `/api/contents/:id` endpoint answers 404 until it is restored. Purged
 * Contents stay hidden for good. Times are the real clock rather than the fixed `now` of the
 * other fakes, because the page counts the days left against its own clock.
 */

const DAY_MS = 86_400_000;
const RETENTION_MS = TRASH_RETENTION_DAYS * DAY_MS;

/** A Content that exists only in the trash, its retention already run out. */
export const EXPIRED_TRASH_CONTENT = "01J0000000000000000000TR01";
export const EXPIRED_TRASH_TITLE = "第零讲：已到期的模拟课程";
const EXPIRED_TRASH_VIDEO = "mockExpired1";
const EXPIRED_TRASH_MEDIA_BYTES = 50 * 1024 * 1024;

/** A Content of the library as the trash needs it: its DTO and the bytes of its media files. */
export interface LibraryContent {
  content: ContentDto;
  mediaBytes: number;
}

interface TrashEntry extends LibraryContent {
  trashedAt: number;
}

export interface MockTrash {
  /** Ids in the trash, newest first. */
  ids(): string[];
  /** Ids purged for good, in purge order. */
  purged(): string[];
  /** Moves a library Content to the trash as if the user had deleted it `ageMs` ago. */
  seed(contentId: string, ageMs?: number): TrashItemDto;
  /** Puts a Content whose retention ran out a day ago in the trash: it can only wait for the sweep or be purged. */
  seedExpired(): TrashItemDto;
}

export class TrashState {
  private readonly entries = new Map<string, TrashEntry>();
  private readonly purgedIds: string[] = [];
  private readonly lookup: (contentId: string) => LibraryContent | undefined;

  /** `lookup` resolves a Content id the library knows; undefined for unknown ids. */
  constructor(lookup: (contentId: string) => LibraryContent | undefined) {
    this.lookup = lookup;
  }

  /** In the trash or purged: absent from every listing, 404 on every `/api/contents/:id` endpoint. */
  hidden(contentId: string): boolean {
    return this.entries.has(contentId) || this.purgedIds.includes(contentId);
  }

  ordered(): TrashEntry[] {
    return [...this.entries.values()].sort((a, b) => b.trashedAt - a.trashedAt || (a.content.id < b.content.id ? 1 : -1));
  }

  put(entry: LibraryContent, trashedAt: number): TrashItemDto {
    const stored = { ...entry, trashedAt };
    this.entries.set(entry.content.id, stored);
    return item(stored);
  }

  /** `DELETE /api/contents/:id`; false when the Content is unknown, already trashed or purged. */
  trash(contentId: string): boolean {
    const found = this.hidden(contentId) ? undefined : this.lookup(contentId);
    if (found === undefined) return false;
    this.put(found, Date.now());
    return true;
  }

  /** A direct re-import of a trashed platform video restores it first; an expired one is skipped. */
  restoreForImport(contentId: string): "restored" | "expired" | "absent" {
    const entry = this.entries.get(contentId);
    if (entry === undefined) return "absent";
    if (expired(entry)) return "expired";
    this.entries.delete(contentId);
    return "restored";
  }

  take(contentId: string): TrashEntry | undefined {
    return this.entries.get(contentId);
  }

  restore(contentId: string): void {
    this.entries.delete(contentId);
  }

  purge(contentId: string): void {
    this.entries.delete(contentId);
    this.purgedIds.push(contentId);
  }

  mock(): MockTrash {
    return {
      ids: () => this.ordered().map((entry) => entry.content.id),
      purged: () => [...this.purgedIds],
      seed: (contentId, ageMs = 0) => {
        const found = this.lookup(contentId);
        if (found === undefined) throw new Error(`unknown content ${contentId}`);
        return this.put(found, Date.now() - ageMs);
      },
      seedExpired: () => this.put(expiredContent(), Date.now() - RETENTION_MS - DAY_MS),
    };
  }
}

function expired(entry: TrashEntry): boolean {
  return Date.now() >= entry.trashedAt + RETENTION_MS;
}

function item(entry: TrashEntry): TrashItemDto {
  const { content } = entry;
  return trashItemDtoSchema.parse({
    id: content.id,
    ...(content.title === undefined ? {} : { title: content.title }),
    source: content.source,
    ...(content.coverUrl === undefined ? {} : { coverUrl: content.coverUrl }),
    ...(content.durationMs === undefined ? {} : { durationMs: content.durationMs }),
    trashedAt: entry.trashedAt,
    purgeAt: entry.trashedAt + RETENTION_MS,
    expired: expired(entry),
    mediaBytes: entry.mediaBytes,
  });
}

function expiredContent(): LibraryContent {
  const createdAt = Date.now() - RETENTION_MS - 2 * DAY_MS;
  return {
    content: contentDtoSchema.parse({
      id: EXPIRED_TRASH_CONTENT,
      source: { kind: "youtube", sourceUrl: `https://www.youtube.com/watch?v=${EXPIRED_TRASH_VIDEO}`, platformContentId: EXPIRED_TRASH_VIDEO },
      title: EXPIRED_TRASH_TITLE,
      durationMs: 3_600_000,
      processingStatus: "succeeded",
      collections: [],
      createdAt,
      updatedAt: createdAt,
    }),
    mediaBytes: EXPIRED_TRASH_MEDIA_BYTES,
  };
}

function errorBody(errorClass: ErrorClass, code: string): unknown {
  return errorResponseSchema.parse({
    error: { class: errorClass, code, retryDisposition: ERROR_CLASS_DEFAULTS[errorClass].retryDisposition ?? "never", userMessage: "" },
  });
}

/**
 * `/api/trash*`, `DELETE /api/contents/:id`, and the 404 of every other `/api/contents/:id`
 * endpoint of a hidden Content; false for anything else.
 */
export async function handleTrash(state: TrashState, route: Route, request: Request, url: URL): Promise<boolean> {
  const method = request.method();
  const path = url.pathname;
  const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const notFound = () => json(errorBody("not_found", "not_found"), 404);

  const contentMatch = /^\/api\/contents\/([^/]+)(\/.*)?$/.exec(path);
  if (contentMatch !== null) {
    const contentId = decodeURIComponent(contentMatch[1] as string);
    if (method === "DELETE" && contentMatch[2] === undefined) {
      return (await (state.trash(contentId) ? route.fulfill({ status: 204, body: "" }) : notFound()), true);
    }
    if (state.hidden(contentId)) return (await notFound(), true);
    return false;
  }

  if (path === "/api/trash") {
    if (method === "GET") {
      const ordered = state.ordered();
      const limit = Number(url.searchParams.get("limit") ?? API_PAGE_SIZE_DEFAULT);
      const pageNumber = url.searchParams.get("page");
      // A numbered page carries no nextCursor; one past the end is empty.
      if (pageNumber !== null) {
        const from = (Number(pageNumber) - 1) * limit;
        return (await json(trashListDtoSchema.parse({ items: ordered.slice(from, from + limit).map(item), total: ordered.length })), true);
      }
      const cursor = url.searchParams.get("cursor");
      const from = cursor === null || cursor === "" ? 0 : ordered.findIndex((entry) => `${entry.trashedAt}:${entry.content.id}` === cursor) + 1;
      const page = ordered.slice(from, from + limit);
      const last = page.at(-1);
      return (
        await json(
          trashListDtoSchema.parse({
            items: page.map(item),
            total: ordered.length,
            ...(from + limit < ordered.length && last !== undefined ? { nextCursor: `${last.trashedAt}:${last.content.id}` } : {}),
          }),
        ),
        true
      );
    }
    if (method === "DELETE") {
      const purgedIds = state.ordered().map((entry) => entry.content.id);
      for (const id of purgedIds) state.purge(id);
      return (await json(trashPurgeAllDtoSchema.parse({ purgedIds, failed: [] })), true);
    }
    return false;
  }

  const restoreMatch = /^\/api\/trash\/([^/]+)\/restore$/.exec(path);
  if (restoreMatch !== null && method === "POST") {
    const entry = state.take(decodeURIComponent(restoreMatch[1] as string));
    if (entry === undefined) return (await notFound(), true);
    if (expired(entry)) return (await json(errorBody("conflict", "conflict.trash_expired"), 409), true);
    state.restore(entry.content.id);
    // Restoring leaves the Content as it was, `updatedAt` included.
    return (await json(contentDtoSchema.parse(entry.content)), true);
  }

  const itemMatch = /^\/api\/trash\/([^/]+)$/.exec(path);
  if (itemMatch !== null && method === "DELETE") {
    const entry = state.take(decodeURIComponent(itemMatch[1] as string));
    if (entry === undefined) return (await notFound(), true);
    state.purge(entry.content.id);
    return (await route.fulfill({ status: 204, body: "" }), true);
  }
  return false;
}
