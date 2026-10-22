import { describe, expect, it } from "vitest";
import { TaskEventBus } from "../../../src/server/pipeline/events.ts";
import { transact } from "../../../src/server/pipeline/publish.ts";
import type { Repository } from "../../../src/server/ports/repository.ts";

const event = { type: "task.updated", task: { id: "t", kind: "burn", statusProjection: "queued", createdAt: 1 } } as const;
const repository: Repository = { withTransaction: (work) => work({} as never) };

describe("transact", () => {
  it("publishes queued events only after the transaction returns", () => {
    const bus = new TaskEventBus();
    const seen: number[] = [];
    bus.subscribe((published) => seen.push(published.seq));
    transact(repository, bus, (_scope, outbox) => {
      outbox.push("u", event);
      expect(seen).toEqual([]);
    });
    expect(seen).toEqual([1]);
  });

  it("publishes nothing when the transaction throws", () => {
    const bus = new TaskEventBus();
    expect(() =>
      transact(repository, bus, (_scope, outbox) => {
        outbox.push("u", event);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(bus.currentSeq()).toBe(0);
  });
});
