import type { Migration } from "../migrations.ts";

/**
 * Semantic paragraph starts of a transcript revision: NULL means the revision was never
 * paragraphed (roots and older proofreads), 0 / 1 is the proofreading model's judgement.
 * Existing rows stay NULL: inferring marks would mean either a model call no user asked
 * for or rewriting committed revisions, and neither is allowed. The column is added
 * rather than the rows rewritten, so the immutability triggers of 0002 are untouched.
 */
export const migration0010: Migration = {
  version: 10,
  name: "paragraph-start",
  sql: `
    ALTER TABLE transcript_segment ADD COLUMN paragraph_start INTEGER CHECK (paragraph_start IS NULL OR paragraph_start IN (0, 1));
  `,
};
