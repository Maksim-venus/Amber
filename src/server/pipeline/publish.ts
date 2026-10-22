import type { TaskEvent } from "../../shared/sse/events.ts";
import type { NotPromise, Repository, RepositoryScope } from "../ports/repository.ts";
import type { TaskEventBus } from "./events.ts";

/** Events collected inside a transaction and published only once it has committed. */
export class Outbox {
  private readonly pending: Array<{ userId: string; event: TaskEvent }> = [];

  push(userId: string, event: TaskEvent): void {
    this.pending.push({ userId, event });
  }

  drainTo(bus: TaskEventBus): void {
    for (const { userId, event } of this.pending.splice(0)) {
      bus.publish(userId, event);
    }
  }
}

/**
 * Runs `work` in one transaction and publishes the events it queued after commit, in
 * order. A rollback discards them: no event ever describes state that
 * was not persisted.
 */
export function transact<T>(
  repository: Repository,
  bus: TaskEventBus,
  work: (scope: RepositoryScope, outbox: Outbox) => NotPromise<T>,
): T {
  const outbox = new Outbox();
  const result = repository.withTransaction((scope) => work(scope, outbox));
  outbox.drainTo(bus);
  return result;
}
