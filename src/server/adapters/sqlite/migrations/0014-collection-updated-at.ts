import type { Migration } from "../migrations.ts";

/**
 * When a Collection last changed. Existing rows take the latest of what
 * already counts as a change and left a timestamp: creation, a lecture joining, a rollup
 * summary revision. Renames, removals and reorders kept none, so they cannot be recovered.
 */
export const migration0014: Migration = {
  version: 14,
  name: "collection-updated-at",
  sql: `
    ALTER TABLE collection ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
    UPDATE collection SET updated_at = max(
      created_at,
      coalesce((SELECT max(added_at) FROM collection_item WHERE collection_id = collection.id), 0),
      coalesce((
        SELECT max(revision.created_at) FROM collection_summary_revision AS revision
        JOIN collection_summary_artifact AS artifact ON artifact.id = revision.artifact_id
        WHERE artifact.collection_id = collection.id
      ), 0)
    );
  `,
};
