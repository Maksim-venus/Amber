import { describe, expect, it } from "vitest";
import { CacheGate } from "../../../src/server/pipeline/cache-gate.ts";

describe("CacheGate", () => {
  it("nests shared leases and refuses the exclusive one while any is held", () => {
    const gate = new CacheGate();
    const first = gate.tryShared();
    const second = gate.tryShared();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(gate.sharedHeld()).toBe(2);
    expect(gate.tryExclusive("cache_migration")).toBeUndefined();
    first?.();
    expect(gate.tryExclusive("cache_migration")).toBeUndefined();
    second?.();
    expect(gate.sharedHeld()).toBe(0);
    expect(gate.tryExclusive("cache_migration")).toBeDefined();
  });

  it("refuses shared and exclusive leases while the exclusive one is held, and never waits", () => {
    const gate = new CacheGate();
    const exclusive = gate.tryExclusive("cache_migration");
    expect(exclusive).toBeDefined();
    expect(gate.exclusiveHeld()).toBe(true);
    expect(gate.tryShared()).toBeUndefined();
    expect(gate.tryExclusive("cache_migration")).toBeUndefined();
    exclusive?.();
    expect(gate.exclusiveHeld()).toBe(false);
    expect(gate.tryShared()).toBeDefined();
  });

  it("releases are idempotent and order-independent", () => {
    const gate = new CacheGate();
    const a = gate.tryShared() as () => void;
    const b = gate.tryShared() as () => void;
    b();
    b();
    expect(gate.sharedHeld()).toBe(1);
    a();
    a();
    expect(gate.sharedHeld()).toBe(0);
    const exclusive = gate.tryExclusive("cache_migration") as () => void;
    exclusive();
    exclusive();
    expect(gate.exclusiveHeld()).toBe(false);
    expect(gate.tryExclusive("cache_migration")).toBeDefined();
  });

  it("names the holder of the exclusive lease until it is released", () => {
    const gate = new CacheGate();
    expect(gate.exclusiveReason()).toBeUndefined();
    const release = gate.tryExclusive("backup_export") as () => void;
    expect(gate.exclusiveReason()).toBe("backup_export");
    expect(gate.tryExclusive("update_install")).toBeUndefined();
    expect(gate.exclusiveReason()).toBe("backup_export");
    release();
    expect(gate.exclusiveReason()).toBeUndefined();
  });
});
