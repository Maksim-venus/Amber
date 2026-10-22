import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface DataDirLayout {
  root: string;
  database: string;
  /** Pre-migration snapshots and backup archives. */
  backups: string;
  /** `master.key` in server mode. */
  secrets: string;
}

export function dataDirLayout(root: string): DataDirLayout {
  return { root, database: join(root, "amber.db"), backups: join(root, "backups"), secrets: join(root, "secrets") };
}

/**
 * Creates the data directory skeleton. `backups/` and `secrets/` are private to the
 * service account (0700, re-applied on every start in case they were loosened); Windows
 * ignores POSIX modes and relies on the per-user app data ACLs instead.
 */
export function ensureDataDir(root: string): DataDirLayout {
  const layout = dataDirLayout(root);
  mkdirSync(layout.root, { recursive: true });
  for (const privateDir of [layout.backups, layout.secrets]) {
    mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    chmodSync(privateDir, 0o700);
  }
  return layout;
}
