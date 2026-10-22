import { afterEach, describe, expect, it } from "vitest";
import { Maintenance } from "../../../src/server/api/maintenance.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { CacheGate } from "../../../src/server/pipeline/cache-gate.ts";
import { UPDATE_INSTALL_MAINTENANCE_TTL_MS } from "../../../src/shared/defaults.ts";

const created: Maintenance[] = [];
afterEach(() => {
  for (const maintenance of created.splice(0)) maintenance.disarm();
});

function setup(overrides: { unfinished?: number; chat?: boolean; exporting?: boolean; ttlMs?: number } = {}) {
  const gate = new CacheGate();
  const state = { unfinished: overrides.unfinished ?? 0, chat: overrides.chat ?? false, exporting: overrides.exporting ?? false };
  const clock = { now: 1_000_000 };
  const maintenance = new Maintenance({
    gate,
    unfinishedTasks: () => state.unfinished,
    chatInflight: () => state.chat,
    backupExportActive: () => state.exporting,
    now: () => clock.now,
    ...(overrides.ttlMs === undefined ? {} : { ttlMs: overrides.ttlMs }),
  });
  created.push(maintenance);
  return { gate, state, clock, maintenance };
}

function codeOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    if (isAmberError(error)) return error.appError.code;
    throw error;
  }
  return undefined;
}

describe("Maintenance", () => {
  it.each([
    ["an unfinished Task", { unfinished: 1 }, "conflict.tasks_unfinished"],
    ["a streaming chat answer", { chat: true }, "conflict.chat_inflight"],
    ["a running export", { exporting: true }, "conflict.backup_in_progress"],
  ] as const)("refuses with %s and takes nothing", (_name, overrides, code) => {
    const { gate, maintenance } = setup(overrides);
    expect(codeOf(() => maintenance.arm())).toBe(code);
    expect(maintenance.active()).toBe(false);
    expect(gate.exclusiveReason()).toBeUndefined();
  });

  it("refuses while a Task driver or deletion holds a shared lease, or another holder has the exclusive one", () => {
    const { gate, maintenance } = setup();
    const shared = gate.tryShared() as () => void;
    expect(codeOf(() => maintenance.arm())).toBe("conflict.tasks_still_running");
    shared();
    const exclusive = gate.tryExclusive("backup_export") as () => void;
    expect(codeOf(() => maintenance.arm())).toBe("conflict.backup_in_progress");
    exclusive();
    const migration = gate.tryExclusive("cache_migration") as () => void;
    expect(codeOf(() => maintenance.arm())).toBe("conflict.cache_migrating");
    migration();
    expect(maintenance.active()).toBe(false);
  });

  it("arms with the exclusive lease until released, refusing a second arm meanwhile", () => {
    const { gate, clock, maintenance } = setup();
    expect(maintenance.arm()).toEqual({ until: clock.now + UPDATE_INSTALL_MAINTENANCE_TTL_MS });
    expect(maintenance.active()).toBe(true);
    expect(gate.exclusiveReason()).toBe("update_install");
    expect(gate.tryShared()).toBeUndefined();
    expect(codeOf(() => maintenance.arm())).toBe("conflict.maintenance");
    maintenance.disarm();
    expect(maintenance.active()).toBe(false);
    expect(gate.exclusiveReason()).toBeUndefined();
    maintenance.disarm();
  });

  it("ends by itself once the TTL has passed, giving the lease back", async () => {
    const { gate, clock, maintenance } = setup();
    maintenance.arm();
    clock.now += UPDATE_INSTALL_MAINTENANCE_TTL_MS;
    expect(maintenance.active()).toBe(false);
    expect(gate.exclusiveReason()).toBeUndefined();

    const timed = setup({ ttlMs: 20 });
    timed.maintenance.arm();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(timed.gate.exclusiveReason()).toBeUndefined();
  });

  it("reports activity for display", () => {
    const { maintenance } = setup({ unfinished: 2, chat: true });
    expect(maintenance.activity()).toEqual({ unfinishedTasks: 2, chatInflight: true, backupExport: false });
  });
});
