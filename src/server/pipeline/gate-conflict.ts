import { type AmberError, amberError } from "../domain/errors.ts";
import type { CacheGate } from "./cache-gate.ts";

/**
 * The conflict a caller answers when it cannot take a shared cache lease: the one that
 * names whoever holds the exclusive lease.
 */
export function gateConflict(gate: Pick<CacheGate, "exclusiveReason">): AmberError {
  switch (gate.exclusiveReason()) {
    case "backup_export":
      return amberError("conflict", "a backup export holds the cache", { code: "conflict.backup_in_progress" });
    case "update_install":
      return amberError("conflict", "maintenance before an update install", { code: "conflict.maintenance" });
    default:
      return amberError("conflict", "the video cache is being moved", { code: "conflict.cache_migrating" });
  }
}
