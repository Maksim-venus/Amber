/** A Task's place in the Task queue; also names its fair group `task:<id>`. */
export interface SlotOrder {
  createdAt: number;
  id: string;
}

/** A fair group: one Task, or one user's foreground calls (chat, test connection, API-side heavy work). */
export interface FairGroupRef {
  key: string;
  createdAt: number;
}

/** The fair group of a Task's work. */
export function taskGroup(order: SlotOrder): FairGroupRef {
  return { key: `task:${order.id}`, createdAt: order.createdAt };
}

/**
 * A second gate beside the slot count, consulted per waiter (an LLM model lane). It holds no semantics of its own here: `admits` says whether one more may go now,
 * `onGrant` is told synchronously inside the grant and returns what the holder keeps.
 */
export interface Admission<T> {
  admits(): boolean;
  onGrant(): T;
}

interface Waiter {
  admission: Admission<unknown> | undefined;
  grant: (release: () => void, ticket: unknown) => void;
  fail: (reason: unknown) => void;
}

interface Group {
  key: string;
  /** From the request that created the group; later requests never move it. */
  createdAt: number;
  /** Slots this group holds. */
  active: number;
  /** Value of the grant counter at this group's latest grant; -1 = never granted. */
  lastGrant: number;
  /** Waiters in arrival order. */
  queue: Waiter[];
}

/**
 * Counting semaphore that shares its slots among groups instead of serving one global
 * queue: a Task's many chunk requests must not keep other Tasks or a chat
 * waiting until all of them are done. Each grant goes to the group with the fewest slots
 * held, then the one granted least recently (never-granted first), then the oldest group by
 * (`createdAt`, `key`), among the groups that have a waiter its admission lets in; within a
 * group the first such waiter is served, so a waiter whose lane is full never holds up the
 * group's waiters for other lanes, and waiters of one lane keep their arrival order.
 *
 * Why no group waits forever: a group that waits while holding slots is still making
 * progress, and its `active` falls as those calls finish. A group that waits holding none
 * can only be overtaken by groups that hold none either and were granted earlier or never;
 * each such grant makes the other group's `lastGrant` the newest, so it cannot overtake
 * again. The waiting group is thus overtaken at most once by each group present or created
 * meanwhile, and groups are bounded by the running Tasks plus the users with foreground
 * calls. This holds among waiters an admission lets in; when it lets none in, the lane is
 * what they wait for.
 *
 * The limit is read on every grant: raising it grants waiters on the next `drain()`,
 * lowering it never pre-empts holders, it only stops grants until holders fall below it.
 * Admissions change outside: their owner calls `drain()` once one may let more in.
 * Groups without holders or waiters are forgotten, so the map stays as small as the work.
 */
export class FairSemaphore {
  private readonly groups = new Map<string, Group>();
  private active = 0;
  private grants = 0;
  private readonly limit: () => number;

  constructor(limit: () => number) {
    this.limit = limit;
  }

  /** Slots currently held across all groups. */
  get inFlight(): number {
    return this.active;
  }

  /** Groups with a holder or a waiter. */
  get groupCount(): number {
    return this.groups.size;
  }

  acquire(ref: FairGroupRef, signal: AbortSignal): Promise<() => void> {
    return this.enqueue(ref, signal, undefined).then(({ release }) => release);
  }

  /** Waits for a slot and for `admission` to let the request in; the ticket is what `onGrant` returned. */
  acquireAdmitted<T>(ref: FairGroupRef, signal: AbortSignal, admission: Admission<T>): Promise<{ release: () => void; ticket: T }> {
    return this.enqueue(ref, signal, admission as Admission<unknown>) as Promise<{ release: () => void; ticket: T }>;
  }

  async run<T>(ref: FairGroupRef, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const release = await this.acquire(ref, signal);
    try {
      return await work();
    } finally {
      release();
    }
  }

  /** Turns away every waiter of `admission` with `reason`; holders are untouched. */
  reject(admission: Admission<unknown>, reason: unknown): void {
    for (const group of [...this.groups.values()]) {
      const turnedAway = group.queue.filter((waiter) => waiter.admission === admission);
      if (turnedAway.length === 0) {
        continue;
      }
      group.queue = group.queue.filter((waiter) => waiter.admission !== admission);
      this.forgetIfIdle(group);
      for (const waiter of turnedAway) {
        waiter.fail(reason);
      }
    }
  }

  /** Grants waiting requests while the current limit and their admissions allow. */
  drain(): void {
    while (this.active < this.limit()) {
      const next = this.next();
      if (next === undefined) {
        return;
      }
      const { group, index } = next;
      const [waiter] = group.queue.splice(index, 1) as [Waiter];
      // Accounted inside the loop, before anything else runs, so the next pick sees it.
      const ticket = waiter.admission?.onGrant();
      this.active += 1;
      group.active += 1;
      this.grants += 1;
      group.lastGrant = this.grants;
      let released = false;
      waiter.grant(() => {
        if (!released) {
          released = true;
          this.active -= 1;
          group.active -= 1;
          this.forgetIfIdle(group);
          this.drain();
        }
      }, ticket);
    }
  }

  private enqueue(ref: FairGroupRef, signal: AbortSignal, admission: Admission<unknown> | undefined): Promise<{ release: () => void; ticket: unknown }> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const group = this.groupOf(ref);
      const waiter: Waiter = {
        admission,
        grant: (release, ticket) => {
          signal.removeEventListener("abort", onAbort);
          resolve({ release, ticket });
        },
        fail: (reason) => {
          signal.removeEventListener("abort", onAbort);
          reject(reason);
        },
      };
      const onAbort = (): void => {
        const index = group.queue.indexOf(waiter);
        if (index >= 0) {
          group.queue.splice(index, 1);
          this.forgetIfIdle(group);
        }
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      group.queue.push(waiter);
      this.drain();
    });
  }

  private groupOf(ref: FairGroupRef): Group {
    let group = this.groups.get(ref.key);
    if (group === undefined) {
      group = { key: ref.key, createdAt: ref.createdAt, active: 0, lastGrant: -1, queue: [] };
      this.groups.set(ref.key, group);
    }
    return group;
  }

  /**
   * The group the next slot goes to and its first admissible waiter. Each admission is
   * asked once per pick, so the scan stays linear in the waiters.
   */
  private next(): { group: Group; index: number } | undefined {
    const verdicts = new Map<Admission<unknown>, boolean>();
    const admissible = (waiter: Waiter): boolean => {
      if (waiter.admission === undefined) {
        return true;
      }
      let verdict = verdicts.get(waiter.admission);
      if (verdict === undefined) {
        verdict = waiter.admission.admits();
        verdicts.set(waiter.admission, verdict);
      }
      return verdict;
    };
    let best: { group: Group; index: number } | undefined;
    for (const group of this.groups.values()) {
      if (group.queue.length === 0 || (best !== undefined && compareGroups(group, best.group) >= 0)) {
        continue;
      }
      const index = group.queue.findIndex(admissible);
      if (index >= 0) {
        best = { group, index };
      }
    }
    return best;
  }

  private forgetIfIdle(group: Group): void {
    if (group.active === 0 && group.queue.length === 0 && this.groups.get(group.key) === group) {
      this.groups.delete(group.key);
    }
  }
}

function compareGroups(a: Group, b: Group): number {
  return (
    a.active - b.active ||
    a.lastGrant - b.lastGrant ||
    a.createdAt - b.createdAt ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}
