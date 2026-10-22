import { amberError } from "../domain/errors.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Repository } from "../ports/repository.ts";
import type { CacheGate } from "../pipeline/cache-gate.ts";
import { gateConflict } from "../pipeline/gate-conflict.ts";
import { isTerminalProjection } from "../pipeline/projection.ts";
import { taskScratchRef } from "../pipeline/stages/source-media.ts";
import type { ChatService } from "./chat.ts";
import { filesOfAssets, type PendingFileDeleter } from "./pending-file-delete.ts";

export interface DeleteContentServiceOptions {
  repository: Repository;
  /** The whole purge holds a shared cache lease so a cache move never races it. */
  gate: Pick<CacheGate, "tryShared" | "exclusiveReason">;
  /** Files are registered in the purge transaction and removed by the worker afterwards. */
  fileDeleter: Pick<PendingFileDeleter, "register" | "kick">;
  /** A Content cannot be purged under an answer still streaming about it. */
  chat: Pick<ChatService, "hasInflightFor">;
  now?: () => number;
}

/**
 * Purges a Content with everything cascading from it: the end of the trash,
 * by the user or by the sweep. Refused while any of its Tasks is unfinished
 * (`conflict.tasks_unfinished`), while an answer about it is still streaming
 * (`conflict.chat_inflight`) and while the video cache is being moved
 * (`conflict.cache_migrating`). One transaction registers every file the Content leaves
 * behind with the pending-file queue and deletes the rows; its commit is the purge. The
 * files go afterwards through the queue's worker, which this only wakes: a file that cannot
 * be removed yet, or a cache directory that is unplugged, never turns a committed purge
 * into an error. `external_local` files are the user's own and are never touched: only
 * their rows go. Invariant: Amber never deletes an `external_local` file.
 */
export class DeleteContentService {
  private readonly options: DeleteContentServiceOptions;
  private readonly now: () => number;

  constructor(options: DeleteContentServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** Purges any of the principal's Contents, in the trash or not. */
  async delete(principal: RequestPrincipal, contentId: string): Promise<void> {
    await this.purge(principal.userId, contentId, { onlyTrashed: false });
  }

  /**
   * With `onlyTrashed`, a Content outside the trash is `not_found`, as the trash endpoints
   * require. `kick: false` leaves waking the file worker to a caller purging many in a row.
   */
  async purge(owner: string, contentId: string, options: { onlyTrashed: boolean; kick?: boolean }): Promise<void> {
    const release = this.options.gate.tryShared();
    if (release === undefined) {
      throw gateConflict(this.options.gate);
    }
    try {
      this.purgeLocked(owner, contentId, options.onlyTrashed);
    } finally {
      release();
    }
    if (options.kick !== false) {
      this.options.fileDeleter.kick();
    }
  }

  private purgeLocked(owner: string, contentId: string, onlyTrashed: boolean): void {
    const { fileDeleter, chat } = this.options;
    this.options.repository.withTransaction((scope) => {
      const content = scope.contents.getIncludingTrashed(owner, contentId);
      if (content === undefined || (onlyTrashed && content.trashedAt === undefined)) {
        throw amberError("not_found", "content not found");
      }
      const tasks = scope.tasks.listByContent(owner, contentId);
      if (tasks.some((task) => !isTerminalProjection(task.statusProjection))) {
        throw amberError("conflict", "the content still has unfinished tasks", { code: "conflict.tasks_unfinished" });
      }
      if (chat.hasInflightFor(owner, contentId)) {
        throw amberError("conflict", "an answer about the content is still streaming", { code: "conflict.chat_inflight" });
      }
      fileDeleter.register(scope, [
        ...filesOfAssets(scope, scope.mediaAssets.listByContent(owner, contentId)),
        // Scratch directories are Task-scoped and always live in the data directory.
        ...tasks.map((task) => ({ store: "data" as const, storageRef: taskScratchRef(task.id), userId: owner })),
      ]);
      // Its items go with it by cascade; the collections that lose them have changed.
      scope.collections.touchByContent(owner, contentId, this.now());
      scope.contents.delete(owner, contentId);
      scope.search.removeContent(owner, contentId);
    });
  }
}
