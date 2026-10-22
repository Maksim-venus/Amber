import type { Migration } from "../migrations.ts";

/**
 * A Content has at most one TranscriptDraft. Should an older
 * database hold several, only the most recently saved one survives; the others were
 * never reachable through the API, which only ever reads the Content's single draft.
 */
export const migration0005: Migration = {
  version: 5,
  name: "transcript-draft-unique",
  sql: `
    DELETE FROM transcript_draft
    WHERE id NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY content_id ORDER BY updated_at DESC, id DESC) AS rank
        FROM transcript_draft
      )
      WHERE rank = 1
    );
    DROP INDEX transcript_draft_content;
    CREATE UNIQUE INDEX transcript_draft_content ON transcript_draft (content_id);
  `,
};
