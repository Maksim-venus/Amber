import type { Migration } from "../migrations.ts";

/**
 * The user's own title and pin of a Content. `custom_title` sits beside `title` instead
 * of replacing it: the `source` stage keeps writing the platform title on every run, so a
 * rename kept in the same column would be undone by a re-run, and the original must stay
 * available for the "restore original title" action. Both are NULL for every existing row.
 */
export const migration0011: Migration = {
  version: 11,
  name: "content-custom-title-pinned",
  sql: `
    ALTER TABLE content ADD COLUMN custom_title TEXT;
    ALTER TABLE content ADD COLUMN pinned_at INTEGER;
  `,
};
