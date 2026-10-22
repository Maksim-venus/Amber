import { describe, expect, it } from "vitest";
import { CacheGate, type ExclusiveReason } from "../../../src/server/pipeline/cache-gate.ts";
import { gateConflict } from "../../../src/server/pipeline/gate-conflict.ts";

describe("gateConflict", () => {
  it.each([
    ["cache_migration", "conflict.cache_migrating"],
    ["backup_export", "conflict.backup_in_progress"],
    ["update_install", "conflict.maintenance"],
  ] as const)("answers %s with %s", (reason: ExclusiveReason, code) => {
    const gate = new CacheGate();
    gate.tryExclusive(reason);
    const error = gateConflict(gate);
    expect(error.appError.class).toBe("conflict");
    expect(error.appError.code).toBe(code);
  });
});
