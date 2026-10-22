import { describe, expect, it } from "vitest";
import { FairSemaphore, type Admission, type FairGroupRef } from "../../../src/server/pipeline/fair-semaphore.ts";

/** Lets every resolved grant run its continuation. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Drives a FairSemaphore by hand: requests are labelled `<group>:<n>`, every grant is logged
 * in order, and holders are released one at a time, oldest first unless named.
 */
class Rig {
  readonly semaphore: FairSemaphore;
  readonly granted: string[] = [];
  readonly held: Array<{ label: string; release: () => void }> = [];
  peak = 0;
  limit: number;
  private readonly counts = new Map<string, number>();

  constructor(limit: number) {
    this.limit = limit;
    this.semaphore = new FairSemaphore(() => this.limit);
  }

  request(group: string | FairGroupRef, count = 1, signal: AbortSignal = new AbortController().signal): Promise<void>[] {
    const ref = typeof group === "string" ? { key: group, createdAt: 0 } : group;
    return Array.from({ length: count }, () => {
      const n = (this.counts.get(ref.key) ?? 0) + 1;
      this.counts.set(ref.key, n);
      const label = `${ref.key}:${n}`;
      return this.semaphore.acquire(ref, signal).then((release) => {
        this.granted.push(label);
        this.held.push({ label, release });
        this.peak = Math.max(this.peak, this.held.length);
      });
    });
  }

  async release(label?: string): Promise<void> {
    const index = label === undefined ? 0 : this.held.findIndex((holder) => holder.label === label);
    const [holder] = this.held.splice(index, 1);
    if (holder === undefined) {
      throw new Error(`nothing held${label === undefined ? "" : ` as ${label}`}`);
    }
    holder.release();
    await settle();
  }

  /** Releases holders oldest first until nothing is held or waiting. */
  async releaseAll(onRelease?: () => void): Promise<void> {
    while (this.held.length > 0) {
      onRelease?.();
      await this.release();
    }
  }

  groupsOf(): string[] {
    return this.granted.map((label) => label.slice(0, label.lastIndexOf(":")));
  }
}

/** The largest distance between two consecutive grants of `group`. */
function maxGap(groups: readonly string[], group: string): number {
  let previous: number | undefined;
  let gap = 0;
  groups.forEach((name, index) => {
    if (name === group) {
      gap = Math.max(gap, index - (previous ?? index));
      previous = index;
    }
  });
  return gap;
}

describe("FairSemaphore", () => {
  it("rotates three groups over two slots: the third starts long before the first two finish", async () => {
    const rig = new Rig(2);
    rig.request({ key: "a", createdAt: 1 }, 10);
    rig.request({ key: "b", createdAt: 2 }, 10);
    rig.request({ key: "c", createdAt: 3 }, 10);
    await settle();
    await rig.releaseAll();
    const groups = rig.groupsOf();
    expect(groups).toHaveLength(30);
    // A arrived alone and took both slots; B and C get the next two.
    expect(groups.slice(0, 4)).toEqual(["a", "a", "b", "c"]);
    expect(groups.indexOf("c")).toBeLessThan(groups.lastIndexOf("a"));
    expect(groups.indexOf("c")).toBeLessThan(groups.lastIndexOf("b"));
    for (const group of ["a", "b", "c"]) {
      expect(maxGap(groups, group)).toBeLessThanOrEqual(3);
    }
    expect(rig.peak).toBe(2);
  });

  it("gives each of five groups over three slots a grant within a bounded number of grants", async () => {
    const rig = new Rig(3);
    const keys = ["a", "b", "c", "d", "e"];
    keys.forEach((key, index) => rig.request({ key, createdAt: index }, 8));
    await settle();
    await rig.releaseAll();
    const groups = rig.groupsOf();
    expect(groups).toHaveLength(40);
    for (const key of keys) {
      // A arrived alone and took all three slots; every other group follows within one
      // round, and no group waits more than one round between grants.
      expect(groups.indexOf(key)).toBeLessThan(rig.limit + keys.length - 1);
      expect(maxGap(groups, key)).toBeLessThanOrEqual(keys.length);
    }
    expect(rig.peak).toBe(3);
  });

  it("serves a late single request at the next free slot, ahead of a backlog of 100", async () => {
    const rig = new Rig(2);
    rig.request({ key: "a", createdAt: 1 }, 100);
    await settle();
    expect(rig.granted).toEqual(["a:1", "a:2"]);
    rig.request({ key: "b", createdAt: 2 });
    await settle();
    await rig.release();
    expect(rig.granted).toEqual(["a:1", "a:2", "b:1"]);
    await rig.releaseAll();
    expect(rig.granted).toHaveLength(101);
  });

  it("does not starve older groups while new groups keep arriving", async () => {
    const rig = new Rig(1);
    rig.request({ key: "a", createdAt: 1 }, 20);
    rig.request({ key: "b", createdAt: 2 }, 20);
    await settle();
    let arrivals = 0;
    // A new group with two requests joins after every third release, for as long as A and B wait.
    let releases = 0;
    await rig.releaseAll(() => {
      releases += 1;
      if (releases % 3 === 0 && arrivals < 12) {
        arrivals += 1;
        rig.request({ key: `n${String(arrivals).padStart(2, "0")}`, createdAt: 2 + arrivals }, 2);
      }
    });
    const groups = rig.groupsOf();
    expect(arrivals).toBe(12);
    expect(groups.filter((group) => group === "a")).toHaveLength(20);
    // Each newcomer overtakes the old groups once, then joins the rotation: the gap stays
    // bounded by the groups waiting at once, however many newcomers arrive in total.
    expect(maxGap(groups, "a")).toBeLessThanOrEqual(6);
    expect(maxGap(groups, "b")).toBeLessThanOrEqual(6);
    // The last newcomer arrives while A still waits: A was not pushed to the end.
    expect(groups.lastIndexOf("a")).toBeGreaterThan(groups.indexOf("n12"));
  });

  it("rotates groups with a single slot and never has more than one in flight", async () => {
    const rig = new Rig(1);
    rig.request({ key: "a", createdAt: 1 }, 3);
    rig.request({ key: "b", createdAt: 2 }, 3);
    rig.request({ key: "c", createdAt: 3 }, 3);
    await settle();
    await rig.releaseAll();
    expect(rig.groupsOf()).toEqual(["a", "b", "c", "a", "b", "c", "a", "b", "c"]);
    expect(rig.peak).toBe(1);
  });

  it("serves requests within a group in arrival order", async () => {
    const rig = new Rig(1);
    rig.request({ key: "a", createdAt: 1 }, 4);
    rig.request({ key: "b", createdAt: 2 }, 2);
    rig.request({ key: "a", createdAt: 1 }, 2);
    await settle();
    await rig.releaseAll();
    expect(rig.granted.filter((label) => label.startsWith("a:"))).toEqual(["a:1", "a:2", "a:3", "a:4", "a:5", "a:6"]);
    expect(rig.granted.filter((label) => label.startsWith("b:"))).toEqual(["b:1", "b:2"]);
  });

  it("orders never-granted groups by createdAt, then key, keeping a group's first createdAt", async () => {
    const rig = new Rig(1);
    rig.request({ key: "x", createdAt: 0 });
    await settle();
    rig.request({ key: "b", createdAt: 5 });
    rig.request({ key: "a", createdAt: 5 });
    rig.request({ key: "z", createdAt: 3 });
    // A later request of `b` claims an older createdAt; the group keeps its first.
    rig.request({ key: "b", createdAt: 1 });
    await settle();
    await rig.releaseAll();
    expect(rig.granted).toEqual(["x:1", "z:1", "a:1", "b:1", "b:2"]);
  });

  it("drops an aborted waiter without granting it, releases once and forgets idle groups", async () => {
    const rig = new Rig(1);
    rig.request("a");
    await settle();
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const [aborted] = rig.request("b", 1, controller.signal);
    rig.request("c");
    expect(rig.semaphore.groupCount).toBe(3);
    controller.abort(reason);
    await expect(aborted).rejects.toBe(reason);
    expect(rig.semaphore.groupCount).toBe(2);

    // An already-aborted signal is refused at once and creates no group.
    const done = new AbortController();
    done.abort(reason);
    await expect(rig.semaphore.acquire({ key: "d", createdAt: 0 }, done.signal)).rejects.toBe(reason);
    expect(rig.semaphore.groupCount).toBe(2);

    // Releasing twice frees one slot only.
    const [holder] = rig.held.splice(0, 1);
    holder?.release();
    holder?.release();
    await settle();
    expect(rig.granted).toEqual(["a:1", "c:1"]);
    expect(rig.semaphore.inFlight).toBe(1);
    await rig.releaseAll();
    expect(rig.granted).toEqual(["a:1", "c:1"]);
    expect(rig.semaphore.inFlight).toBe(0);
    expect(rig.semaphore.groupCount).toBe(0);
  });

  it("grants at once when the limit is raised and never pre-empts when it is lowered", async () => {
    const rig = new Rig(2);
    rig.request({ key: "a", createdAt: 1 }, 5);
    rig.request({ key: "b", createdAt: 2 }, 5);
    await settle();
    expect(rig.held).toHaveLength(2);

    rig.limit = 4;
    rig.semaphore.drain();
    await settle();
    expect(rig.held).toHaveLength(4);
    expect(rig.semaphore.inFlight).toBe(4);

    rig.limit = 1;
    rig.semaphore.drain();
    await settle();
    // Nobody is pre-empted, and nothing new starts until in-flight work falls below the limit.
    expect(rig.held).toHaveLength(4);
    const granted = rig.granted.length;
    await rig.release();
    await rig.release();
    await rig.release();
    expect(rig.held).toHaveLength(1);
    expect(rig.granted).toHaveLength(granted);
    await rig.release();
    expect(rig.held).toHaveLength(1);
    expect(rig.granted).toHaveLength(granted + 1);
    await rig.releaseAll();
    expect(rig.granted).toHaveLength(10);
    expect(rig.semaphore.groupCount).toBe(0);
  });
});

describe("FairSemaphore with admissions", () => {
  /** A gate per request kind, like a model lane: lets `open` more in, counting grants. */
  function gateOf(open: number): Admission<number> & { open: number; granted: number } {
    return {
      open,
      granted: 0,
      admits() {
        return this.granted < this.open;
      },
      onGrant() {
        this.granted += 1;
        return this.granted;
      },
    };
  }
  const never = new AbortController().signal;
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it("lets a group's waiter for an open lane past its head waiting for a full one, keeping each lane's order", async () => {
    const semaphore = new FairSemaphore(() => Number.POSITIVE_INFINITY);
    const full = gateOf(0);
    const open = gateOf(2);
    const order: string[] = [];
    const group = { key: "foreground:u", createdAt: 1 };
    void semaphore.acquireAdmitted(group, never, full).then(() => order.push("full:1"));
    void semaphore.acquireAdmitted(group, never, open).then(({ ticket }) => order.push(`open:${ticket}`));
    void semaphore.acquireAdmitted(group, never, full).then(() => order.push("full:2"));
    void semaphore.acquireAdmitted(group, never, open).then(({ ticket }) => order.push(`open:${ticket}`));
    await flush();
    expect(order).toEqual(["open:1", "open:2"]);
    full.open = 2;
    semaphore.drain();
    await flush();
    expect(order).toEqual(["open:1", "open:2", "full:1", "full:2"]);
  });

  it("does not let a group wait for a lane that is full while other groups' lanes are open", async () => {
    const semaphore = new FairSemaphore(() => Number.POSITIVE_INFINITY);
    const cooling = gateOf(0);
    const fine = gateOf(5);
    const granted: string[] = [];
    void semaphore.acquireAdmitted({ key: "task:a", createdAt: 1 }, never, cooling).then(() => granted.push("a"));
    void semaphore.acquireAdmitted({ key: "task:b", createdAt: 2 }, never, fine).then(() => granted.push("b"));
    await flush();
    expect(granted).toEqual(["b"]);
  });

  it("accounts each grant inside the drain, so one pass never admits more than the lane allows", async () => {
    const semaphore = new FairSemaphore(() => Number.POSITIVE_INFINITY);
    const lane = gateOf(2);
    let granted = 0;
    for (let n = 0; n < 5; n += 1) {
      void semaphore.acquireAdmitted({ key: `task:${n}`, createdAt: n }, never, lane).then(() => (granted += 1));
    }
    await flush();
    expect(granted).toBe(2);
    expect(semaphore.inFlight).toBe(2);
  });

  it("turns away the waiters of one lane only, leaving holders and other lanes alone", async () => {
    const semaphore = new FairSemaphore(() => Number.POSITIVE_INFINITY);
    const lane = gateOf(1);
    const other = gateOf(0);
    const holder = await semaphore.acquireAdmitted({ key: "task:a", createdAt: 1 }, never, lane);
    const waiting = semaphore.acquireAdmitted({ key: "task:b", createdAt: 2 }, never, lane);
    const elsewhere = semaphore.acquireAdmitted({ key: "task:c", createdAt: 3 }, never, other);
    const reason = new Error("cooling");
    semaphore.reject(lane, reason);
    await expect(waiting).rejects.toBe(reason);
    other.open = 1;
    semaphore.drain();
    await expect(elsewhere).resolves.toMatchObject({ ticket: 1 });
    expect(semaphore.inFlight).toBe(2);
    holder.release();
    expect(semaphore.inFlight).toBe(1);
  });
});
