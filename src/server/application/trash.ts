import { TRASH_SWEEP_BATCH } from "../../shared/defaults.ts";
import type { ContentDto } from "../../shared/dto/content.ts";
import type { TrashItemDto, TrashListDto, TrashPurgeAllDto } from "../../shared/dto/trash.ts";
import { displayTitle, TRASH_RETENTION_MS, trashPurgeAt, type Content } from "../domain/content.ts";
import { amberError, isAmberError } from "../domain/errors.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Logger } from "../ports/logger.ts";
import type { Repository, RepositoryScope, TrashCursor } from "../ports/repository.ts";
import { isTerminalProjection } from "../pipeline/projection.ts";
import { MAX_TIMER_MS } from "../pipeline/scheduler.ts";
import type { ChatService } from "./chat.ts";
import { frozenMemberIds } from "./collections.ts";
import { contentDtos } from "./contents.ts";
import type { DeleteContentService } from "./delete-content.ts";
import { retryBackoffMs, type PendingFileDeleter } from "./pending-file-delete.ts";

export interface TrashServiceOptions {
  repository: Repository;
  deleteContent: Pick<DeleteContentService, "purge">;
  fileDeleter: Pick<PendingFileDeleter, "kick" | "nextDueAt">;
  /** Answers still streaming about a Content are aborted when it goes to the trash. */
  chat: Pick<ChatService, "abortContent">;
  logger: Logger;
  now?: () => number;
  /** Starts an unref'd one-shot timer and returns its cancel function; a test seam. */
  setTimer?: (ms: number, fire: () => void) => () => void;
}

/** The outcome of one sweep. */
export interface TrashSweepResult {
  purged: number;
  /** Expired entries that could not be purged this time (unfinished Task, streaming answer, cache move, …). */
  deferred: number;
}

function defaultTimer(ms: number, fire: () => void): () => void {
  const timer = setTimeout(fire, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

function notInTrash(): never {
  throw amberError("not_found", "content not found in the trash");
}

/**
 * Takes a trashed Content out of the trash inside the caller's transaction:
 * refused once its retention has run out, whether or not the sweep has purged it yet.
 * `updatedAt`, pin and collection positions stay as they were; the search projection
 * comes back and the collections holding it count as changed.
 */
export function restoreTrashed(scope: RepositoryScope, owner: string, content: Content, now: number): void {
  if (content.trashedAt === undefined) {
    notInTrash();
  }
  if (trashPurgeAt(content.trashedAt) <= now) {
    throw amberError("conflict", "the content's time in the trash has run out", { code: "conflict.trash_expired" });
  }
  scope.contents.restore(owner, content.id);
  scope.search.syncContent(owner, content.id);
  scope.collections.touchByContent(owner, content.id, now);
}

function encodeCursor(position: TrashCursor): string {
  return Buffer.from(JSON.stringify([position.trashedAt, position.id])).toString("base64url");
}

function decodeCursor(cursor: string): TrashCursor {
  try {
    const [trashedAt, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown[];
    if (typeof trashedAt === "number" && Number.isInteger(trashedAt) && typeof id === "string" && id.length > 0) {
      return { trashedAt, id };
    }
  } catch {
    // Fall through to the uniform error below.
  }
  throw amberError("invalid_request", "malformed cursor", { params: { detail: "cursor" } });
}

/**
 * The content trash. Deleting a Content moves it here: rows and
 * files stay, and everything but this service treats it as unknown. It is restorable until
 * `trashedAt + TRASH_RETENTION_DAYS`, strictly; from then on only the sweep, which purges
 * every expired entry at start-up and again when a single timer fires at the next expiry.
 * Purging, by hand or by the sweep, is `DeleteContentService.purge`; an entry the sweep
 * cannot purge yet is retried with the pending-file backoff. The same timer wakes the
 * pending-file worker when its next row is due.
 */
export class TrashService {
  private readonly options: TrashServiceOptions;
  private readonly now: () => number;
  private readonly setTimer: (ms: number, fire: () => void) => () => void;
  private cancelTimer: (() => void) | undefined;
  private sweeping: Promise<TrashSweepResult> | undefined;
  /** Consecutive sweeps that left expired entries behind; drives their backoff. */
  private deferredRounds = 0;
  private armed = false;
  private stopped = false;

  constructor(options: TrashServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? defaultTimer;
  }

  /**
   * `DELETE /api/contents/:id`. Refused while a Task of the Content is unfinished, or while a
   * running collection summary of one of its collections summarises it (both
   * `conflict.tasks_unfinished`). Answers streaming about it are aborted afterwards, without
   * waiting for them to settle.
   */
  trash(principal: RequestPrincipal, contentId: string): void {
    const owner = principal.userId;
    this.options.repository.withTransaction((scope) => {
      if (scope.contents.get(owner, contentId) === undefined) {
        throw amberError("not_found", "content not found");
      }
      if (scope.tasks.listByContent(owner, contentId).some((task) => !isTerminalProjection(task.statusProjection))) {
        throw amberError("conflict", "the content still has unfinished tasks", { code: "conflict.tasks_unfinished" });
      }
      for (const { id: collectionId } of scope.collections.membershipsOf(owner, [contentId]).get(contentId) ?? []) {
        const summarizing = scope.tasks
          .listByCollection(owner, collectionId)
          .some((task) => task.kind === "summarize_collection" && !isTerminalProjection(task.statusProjection) && frozenMemberIds(task.requestJson).includes(contentId));
        if (summarizing) {
          throw amberError("conflict", "a running collection summary uses the content", { code: "conflict.tasks_unfinished" });
        }
      }
      const now = this.now();
      scope.contents.trash(owner, contentId, now);
      scope.search.removeContent(owner, contentId);
      scope.collections.touchByContent(owner, contentId, now);
    });
    this.options.chat.abortContent(owner, contentId);
    this.refresh();
  }

  /** `POST /api/trash/:id/restore`: not in the trash → `not_found`; expired → `conflict.trash_expired`. */
  restore(principal: RequestPrincipal, contentId: string): ContentDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const content = scope.contents.getIncludingTrashed(owner, contentId);
      if (content?.trashedAt === undefined) {
        notInTrash();
      }
      restoreTrashed(scope, owner, content, this.now());
      return contentDtos(scope, owner, [scope.contents.get(owner, contentId) as Content])[0] as ContentDto;
    });
  }

  /** `DELETE /api/trash/:id`: done once the purge commits; the files follow through the worker. */
  async purge(principal: RequestPrincipal, contentId: string): Promise<void> {
    await this.options.deleteContent.purge(principal.userId, contentId, { onlyTrashed: true });
  }

  /** `DELETE /api/trash`: every entry in its own transaction; one that fails is reported and the rest go on. */
  async purgeAll(principal: RequestPrincipal): Promise<TrashPurgeAllDto> {
    const owner = principal.userId;
    const ids = this.options.repository.withTransaction((scope) => scope.contents.listTrashedIds(owner));
    const purgedIds: string[] = [];
    const failed: TrashPurgeAllDto["failed"] = [];
    for (const contentId of ids) {
      try {
        await this.options.deleteContent.purge(owner, contentId, { onlyTrashed: true, kick: false });
        purgedIds.push(contentId);
      } catch (error) {
        if (!isAmberError(error)) {
          this.options.logger.error("trash_purge_failed", { contentId, error: String(error) });
        }
        failed.push({ contentId, code: isAmberError(error) ? error.appError.code : "internal" });
      }
    }
    this.options.fileDeleter.kick();
    return { purgedIds, failed };
  }

  /**
   * `GET /api/trash`: latest `trashedAt` first, expired entries included. `mediaBytes` sums
   * the available files a purge would remove, so never the user's own originals. Pages
   * either by `cursor` or by a 1-based `page` number, never both; a numbered
   * page carries no `nextCursor`, and one past the last page is empty.
   */
  list(principal: RequestPrincipal, query: { limit: number; cursor?: string; page?: number }): TrashListDto {
    const owner = principal.userId;
    if (query.cursor !== undefined && query.page !== undefined) {
      throw amberError("invalid_request", "cursor and page exclude each other", { params: { detail: "page" } });
    }
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const now = this.now();
    return this.options.repository.withTransaction((scope) => {
      const itemOf = (content: Content): TrashItemDto => {
        const trashedAt = content.trashedAt as number;
        const purgeAt = trashPurgeAt(trashedAt);
        const title = displayTitle(content);
        const mediaBytes = scope.mediaAssets
          .listByContent(owner, content.id)
          .filter((asset) => asset.kind !== "external_local" && asset.availability === "available")
          .reduce((sum, asset) => sum + asset.sizeBytes, 0);
        return {
          id: content.id,
          ...(title === undefined ? {} : { title }),
          source: { ...content.source },
          ...(content.coverUrl === undefined ? {} : { coverUrl: content.coverUrl }),
          ...(content.durationMs === undefined ? {} : { durationMs: content.durationMs }),
          trashedAt,
          purgeAt,
          expired: purgeAt <= now,
          mediaBytes,
        };
      };
      if (query.page !== undefined) {
        const total = scope.contents.countTrashed(owner);
        // Compared as page indexes, so an absurdly large page number cannot overflow an offset.
        if (total === 0 || query.page - 1 > Math.floor((total - 1) / query.limit)) {
          return { items: [], total };
        }
        return { items: scope.contents.listTrashed(owner, { limit: query.limit, offset: (query.page - 1) * query.limit }).map(itemOf), total };
      }
      const found = scope.contents.listTrashed(owner, { limit: query.limit + 1, ...(after === undefined ? {} : { after }) });
      const contents = found.slice(0, query.limit);
      const last = contents.at(-1);
      return {
        items: contents.map(itemOf),
        total: scope.contents.countTrashed(owner),
        ...(found.length > query.limit && last !== undefined ? { nextCursor: encodeCursor({ trashedAt: last.trashedAt as number, id: last.id }) } : {}),
      };
    });
  }

  /**
   * Purges every expired entry of every user, `TRASH_SWEEP_BATCH` at a time, each in its own
   * transaction. Concurrent calls share one run. An entry that cannot be purged now is
   * counted as deferred and tried again later; the file worker is woken once at the end.
   */
  sweep(): Promise<TrashSweepResult> {
    this.sweeping ??= this.sweepOnce().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  /** Starts the timer: from now on it is kept set at the next moment something falls due. */
  arm(): void {
    this.armed = true;
    this.refresh();
  }

  /**
   * Re-computes the single timer once armed: the earliest of the next expiry, the next due
   * pending file, and the backoff of entries the last sweep had to leave. No timer when
   * none of them exists.
   */
  refresh(): void {
    if (!this.armed || this.stopped) {
      return;
    }
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    const now = this.now();
    const due: number[] = [];
    const nextTrashed = this.options.repository.withTransaction((scope) => scope.contents.earliestTrashedAfter(now - TRASH_RETENTION_MS));
    if (nextTrashed !== undefined) {
      due.push(trashPurgeAt(nextTrashed));
    }
    const nextFile = this.options.fileDeleter.nextDueAt();
    if (nextFile !== undefined) {
      // A row due already is the worker's at hand; waking for it again at once would only spin.
      due.push(nextFile > now ? nextFile : now + retryBackoffMs(1));
    }
    if (this.deferredRounds > 0) {
      due.push(now + retryBackoffMs(this.deferredRounds));
    }
    if (due.length === 0) {
      return;
    }
    const delay = Math.min(Math.max(0, Math.min(...due) - now), MAX_TIMER_MS);
    this.cancelTimer = this.setTimer(delay, () => void this.fire());
  }

  /** No timer fires any more and a running sweep is waited for. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    await this.sweeping?.catch(() => undefined);
  }

  private async fire(): Promise<void> {
    this.cancelTimer = undefined;
    try {
      await this.sweep();
    } catch (error) {
      this.options.logger.warn("trash_sweep_failed", { error: String(error) });
    } finally {
      this.refresh();
    }
  }

  private async sweepOnce(): Promise<TrashSweepResult> {
    const { repository, deleteContent, logger } = this.options;
    const cutoff = this.now() - TRASH_RETENTION_MS;
    let purged = 0;
    let deferred = 0;
    let after: TrashCursor | undefined;
    for (;;) {
      const batch = repository.withTransaction((scope) => scope.contents.listExpired(cutoff, TRASH_SWEEP_BATCH, after));
      for (const entry of batch) {
        if (this.stopped) {
          break;
        }
        try {
          await deleteContent.purge(entry.userId, entry.id, { onlyTrashed: true, kick: false });
          purged += 1;
        } catch (error) {
          // Restored or purged by hand in the meantime: nothing left to do.
          if (isAmberError(error) && error.appError.class === "not_found") {
            continue;
          }
          deferred += 1;
          logger.warn("trash_purge_deferred", { contentId: entry.id, error: isAmberError(error) ? error.appError.code : String(error) });
        }
      }
      const last = batch.at(-1);
      if (this.stopped || batch.length < TRASH_SWEEP_BATCH || last === undefined) {
        break;
      }
      after = { trashedAt: last.trashedAt, id: last.id };
    }
    this.deferredRounds = deferred > 0 ? this.deferredRounds + 1 : 0;
    this.options.fileDeleter.kick();
    logger.info("trash_sweep_done", { purged, deferred });
    return { purged, deferred };
  }
}
