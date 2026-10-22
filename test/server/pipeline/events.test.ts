import { describe, expect, it } from "vitest";
import { TaskEventBus } from "../../../src/server/pipeline/events.ts";

const event = { type: "task.updated", task: { id: "t", kind: "burn", statusProjection: "queued", createdAt: 1 } } as const;

describe("TaskEventBus", () => {
  it("numbers publications monotonically and stops delivering after unsubscribe", () => {
    const bus = new TaskEventBus();
    const seen: number[] = [];
    const unsubscribe = bus.subscribe((published) => seen.push(published.seq));
    bus.publish("u", event);
    bus.publish("v", event);
    expect(bus.currentSeq()).toBe(2);
    unsubscribe();
    bus.publish("u", event);
    expect(seen).toEqual([1, 2]);
    expect(bus.subscriberCount()).toBe(0);
  });
});
