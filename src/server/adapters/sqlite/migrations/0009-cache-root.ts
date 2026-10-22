import type { Migration } from "../migrations.ts";

/**
 * The client's video cache location: the custom cache root (NULL = the data
 * directory) and the marker of a cache move in progress, which survives a crash so the
 * next start can finish the cleanup or roll the copy back. Both are instance-level and
 * never leave the server (they are not part of the `/instance-settings` DTO).
 */
export const migration0009: Migration = {
  version: 9,
  name: "cache-root",
  sql: `
    ALTER TABLE instance_settings ADD COLUMN cache_root TEXT;
    ALTER TABLE instance_settings ADD COLUMN cache_migration_json TEXT CHECK (cache_migration_json IS NULL OR json_valid(cache_migration_json));
  `,
};
