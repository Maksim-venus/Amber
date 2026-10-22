import { taskDetailDtoSchema, type TaskDetailDto } from "../../shared/dto/task.ts";
import { taskEventSchema, type TaskEvent } from "../../shared/sse/events.ts";
import { ApiError, type ApiClient } from "./client.ts";
import { connectSse, type RawSseFrame, type SseConnection } from "./sse.ts";

export interface TaskView {
  detail?: TaskDetailDto;
  error?: unknown;
  /**
   * The snapshot read answered 404: the task no longer exists for this user (its Content was
   * trashed or purged). No detail is kept, so nothing stale stays on screen.
   */
  gone?: true;
}

type Listener = () => void;

interface Watched {
  view: TaskView;
  listeners: Set<Listener>;
  /** Events received while any snapshot read is in flight; each arriving snapshot replays them. */
  pending: Array<{ seq: number; event: TaskEvent }>;
  /** Snapshot reads in flight (watch start and reconnections may overlap). */
  loads: number;
}

/**
 * Live task state for the UI: one shared SSE subscription, and per watched
 * task a snapshot read when watching starts and again each time the subscription comes up.
 * Only events numbered above the snapshot's `eventSeq` are applied; the re-read on every
 * (re)connection covers events the server published while no subscription existed, since
 * events are not replayed.
 */
export class TaskHub {
  private readonly client: ApiClient;
  private readonly watched = new Map<string, Watched>();
  private readonly eventListeners = new Set<(event: TaskEvent) => void>();
  private connection: SseConnection | undefined;

  constructor(client: ApiClient) {
    this.client = client;
  }

  /** Current view of a task; stable until the next change (for useSyncExternalStore). */
  view(taskId: string): TaskView {
    return this.watched.get(taskId)?.view ?? EMPTY_VIEW;
  }

  watch(taskId: string, listener: Listener): () => void {
    let entry = this.watched.get(taskId);
    if (entry === undefined) {
      entry = { view: EMPTY_VIEW, listeners: new Set(), pending: [], loads: 0 };
      this.watched.set(taskId, entry);
      // Read right away so the view never waits on the stream; every (re)connection reads
      // again, which covers events published before the subscription was up.
      void this.loadSnapshot(taskId);
    }
    entry.listeners.add(listener);
    this.ensureConnection();
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) {
        this.watched.delete(taskId);
      }
      this.maybeDisconnect();
    };
  }

  /** Every task event (lists and badges refresh on them). */
  onEvent(listener: (event: TaskEvent) => void): () => void {
    this.eventListeners.add(listener);
    this.ensureConnection();
    return () => {
      this.eventListeners.delete(listener);
      this.maybeDisconnect();
    };
  }

  /** Re-reads one snapshot, e.g. after a retry or cancel answered. */
  refresh(taskId: string): void {
    if (this.watched.has(taskId)) {
      void this.loadSnapshot(taskId);
    }
  }

  close(): void {
    this.connection?.close();
    this.connection = undefined;
  }

  /**
   * Drops the current subscription and opens a new one when anything is watched, e.g. after
   * the client's endpoint changed; the new connection re-reads every watched snapshot.
   */
  reconnect(): void {
    this.close();
    if (this.watched.size > 0 || this.eventListeners.size > 0) {
      this.ensureConnection();
    }
  }

  private ensureConnection(): void {
    if (this.connection !== undefined) {
      return;
    }
    this.connection = connectSse({
      open: (signal) => this.client.stream("/api/tasks/events", signal),
      onOpen: () => {
        for (const taskId of this.watched.keys()) {
          void this.loadSnapshot(taskId);
        }
      },
      onDown: () => {
          },
      onFrame: (frame) => this.handleFrame(frame),
    });
  }

  private maybeDisconnect(): void {
    if (this.watched.size === 0 && this.eventListeners.size === 0) {
      this.close();
    }
  }

  private handleFrame(frame: RawSseFrame): void {
    if (frame.id === undefined) {
      return;
    }
    let parsed: TaskEvent;
    try {
      const result = taskEventSchema.safeParse({ type: frame.event, ...(JSON.parse(frame.data) as object) });
      if (!result.success) {
        return;
      }
      parsed = result.data;
    } catch {
      return;
    }
    for (const listener of this.eventListeners) {
      listener(parsed);
    }
    for (const entry of this.entriesFor(parsed)) {
      // A task that is gone has nothing to apply events to; only a new snapshot revives it.
      if (entry.view.gone === true && entry.loads === 0) {
        continue;
      }
      if (entry.view.detail === undefined || entry.loads > 0) {
        entry.pending.push({ seq: frame.id, event: parsed });
      } else if (frame.id > entry.view.detail.eventSeq) {
        this.publish(entry, { detail: applyEvent(entry.view.detail, parsed, frame.id) });
      }
    }
  }

  /**
   * Work-unit events carry only their StageRun id: they go to the task that owns that run,
   * or are parked on tasks whose snapshot is still loading (applyEvent drops strangers).
   */
  private entriesFor(event: TaskEvent): Watched[] {
    if (event.type !== "workunit.updated") {
      const entry = this.watched.get(event.type === "stage.updated" ? event.stageRun.taskId : event.task.id);
      return entry === undefined ? [] : [entry];
    }
    return [...this.watched.values()].filter(
      (entry) =>
        entry.view.detail === undefined ||
        entry.loads > 0 ||
        entry.view.detail.stageRuns.some((run) => run.id === event.workUnit.stageRunId),
    );
  }

  private async loadSnapshot(taskId: string): Promise<void> {
    const entry = this.watched.get(taskId);
    if (entry === undefined) {
      return;
    }
    entry.loads += 1;
    try {
      let detail = await this.client.get(`/api/tasks/${encodeURIComponent(taskId)}`, taskDetailDtoSchema);
      for (const { seq, event } of [...entry.pending].sort((a, b) => a.seq - b.seq)) {
        if (seq > detail.eventSeq) {
          detail = applyEvent(detail, event, seq);
        }
      }
      // Overlapping reads may finish out of order: an older snapshot never replaces newer state.
      const current = entry.view.detail;
      if (current !== undefined && current.eventSeq > detail.eventSeq) {
        detail = current;
      }
      this.publish(entry, { detail });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        this.publish(entry, { gone: true, error });
        return;
      }
      this.publish(entry, { ...(entry.view.detail === undefined ? {} : { detail: entry.view.detail }), error });
    } finally {
      entry.loads -= 1;
      if (entry.loads === 0) {
        entry.pending = [];
      }
    }
  }

  private publish(entry: Watched, view: TaskView): void {
    entry.view = view;
    for (const listener of entry.listeners) {
      listener();
    }
  }
}

const EMPTY_VIEW: TaskView = {};

/** Applies one event to a snapshot and advances its sequence so later events stay ordered. */
export function applyEvent(detail: TaskDetailDto, event: TaskEvent, seq: number): TaskDetailDto {
  const next = { ...detail, eventSeq: Math.max(detail.eventSeq, seq) };
  switch (event.type) {
    case "task.updated":
    case "task.finished": {
      // The event carries the whole task, so an optional field it omits has been cleared
      // (a cooldown that ended must not keep the card saying it waits).
      const { retryNotBefore: _cleared, ...rest } = next;
      return { ...rest, ...event.task };
    }
    case "stage.updated": {
      const others = detail.stageRuns.filter((run) => run.id !== event.stageRun.id);
      return { ...next, stageRuns: [...others, event.stageRun] };
    }
    case "workunit.updated": {
      if (!detail.stageRuns.some((run) => run.id === event.workUnit.stageRunId)) {
        return detail;
      }
      const others = detail.workUnits.filter((unit) => unit.id !== event.workUnit.id);
      return { ...next, workUnits: [...others, event.workUnit] };
    }
  }
}
