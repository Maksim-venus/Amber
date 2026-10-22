import type { Migration } from "../migrations.ts";

/**
 * User notes on the transcript view. Composite keys make the database itself
 * hold the anchor invariants: the revision belongs to the note's Content, both sentences
 * belong to that revision, and the Content belongs to the note's owner. The extra unique
 * index on `transcript_segment` exists only to be the target of the sentence keys; `id` is
 * already the primary key, so no existing row can violate it. Only the Content (and so the
 * User) cascades: revisions and sentences are immutable and never deleted on their own.
 */
export const migration0015: Migration = {
  version: 15,
  name: "note",
  sql: `
    CREATE UNIQUE INDEX transcript_segment_id_revision ON transcript_segment (id, revision_id);

    CREATE TABLE note (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
      content_id TEXT NOT NULL,
      transcript_revision_id TEXT NOT NULL,
      start_segment_id TEXT NOT NULL,
      start_offset INTEGER NOT NULL,
      end_segment_id TEXT NOT NULL,
      end_offset INTEGER NOT NULL,
      quote TEXT NOT NULL,
      mark TEXT NOT NULL CHECK (mark IN ('underline', 'background')),
      color TEXT NOT NULL CHECK (color IN ('yellow', 'green', 'blue', 'pink', 'purple')),
      comment TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (start_offset >= 0 AND end_offset > 0),
      FOREIGN KEY (content_id, user_id) REFERENCES content (id, user_id) ON DELETE CASCADE,
      FOREIGN KEY (transcript_revision_id, content_id) REFERENCES transcript_revision (id, content_id),
      FOREIGN KEY (start_segment_id, transcript_revision_id) REFERENCES transcript_segment (id, revision_id),
      FOREIGN KEY (end_segment_id, transcript_revision_id) REFERENCES transcript_segment (id, revision_id)
    ) STRICT;
    CREATE INDEX note_content ON note (content_id, user_id);
    CREATE INDEX note_user_content_created ON note (user_id, content_id, created_at);
    -- Keys of the anchor's revision and sentences, so deleting a Content can check them cheaply.
    CREATE INDEX note_revision ON note (transcript_revision_id, content_id);
    CREATE INDEX note_start_segment ON note (start_segment_id, transcript_revision_id);
    CREATE INDEX note_end_segment ON note (end_segment_id, transcript_revision_id);

    CREATE TRIGGER note_anchor_immutable BEFORE UPDATE ON note
    WHEN new.user_id IS NOT old.user_id
      OR new.content_id IS NOT old.content_id
      OR new.transcript_revision_id IS NOT old.transcript_revision_id
      OR new.start_segment_id IS NOT old.start_segment_id
      OR new.start_offset IS NOT old.start_offset
      OR new.end_segment_id IS NOT old.end_segment_id
      OR new.end_offset IS NOT old.end_offset
      OR new.quote IS NOT old.quote
      OR new.created_at IS NOT old.created_at
    BEGIN
      SELECT RAISE(ABORT, 'note anchor is immutable');
    END;
  `,
};
