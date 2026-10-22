import type { Migration } from "../migrations.ts";

/**
 * The content trash. A Content in the trash keeps every row and
 * file; `trashed_at` alone hides it. `content_trashed` serves one user's trash page,
 * `content_trash_due` the instance-wide sweep of expired entries.
 *
 * `pending_file_delete` is an instance-level work queue like `instance_settings`: a purge
 * or a user deletion registers the files to remove in its own transaction and a worker
 * removes them later. A row names the root its ref was relative to when registered, so a
 * ref is never read against a cache directory that has replaced that root since; it keeps
 * `user_id` only for auditing, without a foreign key, because the intent must outlive the
 * user it came from.
 */
export const migration0016: Migration = {
  version: 16,
  name: "content-trash",
  sql: `
    ALTER TABLE content ADD COLUMN trashed_at INTEGER;
    CREATE INDEX content_trashed ON content (user_id, trashed_at DESC, id DESC) WHERE trashed_at IS NOT NULL;
    CREATE INDEX content_trash_due ON content (trashed_at, id) WHERE trashed_at IS NOT NULL;

    CREATE TABLE pending_file_delete (
      id TEXT PRIMARY KEY,
      store TEXT NOT NULL CHECK (store IN ('data', 'cache')),
      root_path TEXT NOT NULL,
      storage_ref TEXT NOT NULL,
      expected_size_bytes INTEGER,
      user_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (store, root_path, storage_ref)
    ) STRICT;
    CREATE INDEX pending_file_delete_due ON pending_file_delete (next_attempt_at);
  `,
};
