import type { TaskEvent } from "../../shared/sse/events.ts";

export interface PublishedTaskEvent {
  /** Monotonic sequence number, the SSE `id`. */
  seq: number;
  /** Owner of the Task; subscribers only ever see their own user's events. */
  userId: string;
  event: TaskEvent;
}

export type TaskEventListener = (published: PublishedTaskEvent) => void;

/**
 * In-process task event bus. Events are published only after their state
 * transaction commits and each publication increments the sequence. Nothing is kept for
 * replay: a restart ends every SSE stream, and clients resubscribe and reload the snapshot.
 */
export class TaskEventBus {
  private seq = 0;
  private readonly listeners = new Set<TaskEventListener>();

  /** Read before a snapshot is loaded; becomes the snapshot's `eventSeq`. */
  currentSeq(): number {
    return this.seq;
  }

  publish(userId: string, event: TaskEvent): void {
    this.seq += 1;
    const published = { seq: this.seq, userId, event };
    for (const listener of this.listeners) {
      listener(published);
    }
  }

  /** Open subscriptions; a closed SSE stream must leave none behind. */
  subscriberCount(): number {
    return this.listeners.size;
  }

  subscribe(listener: TaskEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
