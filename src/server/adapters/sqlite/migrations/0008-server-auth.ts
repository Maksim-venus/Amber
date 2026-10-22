import type { Migration } from "../migrations.ts";

/**
 * Server-mode identity and network support: `Session` (only the hash of the opaque
 * session id is stored), the instance-level `NetworkAllowlistEntry` (exact origins) whose
 * actor reference survives the user's deletion, and the audit time of the last "reset all
 * credentials". Local mode leaves
 * the session table empty.
 */
export const migration0008: Migration = {
  version: 8,
  name: "server-auth",
  sql: `
    CREATE TABLE session (
      session_id_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
      revoked_at INTEGER
    ) STRICT;
    CREATE INDEX session_user ON session (user_id);

    -- Instance-level: no owner; deleting the user who added an entry only clears its creator.
    CREATE TABLE network_allowlist (
      origin TEXT PRIMARY KEY,
      created_by_user_id TEXT REFERENCES user (id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    ) STRICT;

    ALTER TABLE instance_settings ADD COLUMN credentials_reset_at INTEGER;
  `,
};
