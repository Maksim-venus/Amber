import type { ReferenceText } from "../../../domain/transcript.ts";
import type { ReferenceTextRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { notFound } from "./rows.ts";

interface ReferenceTextRow {
  id: string;
  content_id: string;
  origin: ReferenceText["origin"];
  text: string;
  created_at: number;
}

export function sqliteReferenceTextRepository(db: SqliteConnection): ReferenceTextRepository {
  const ownedContent = db.prepare("SELECT 1 FROM content WHERE id = ? AND user_id = ?");
  const insert = db.prepare(
    "INSERT INTO reference_text (id, content_id, origin, text, created_at) VALUES (@id, @contentId, @origin, @text, @createdAt)",
  );
  const byContent = db.prepare(
    `SELECT reference_text.* FROM reference_text JOIN content ON content.id = reference_text.content_id
     WHERE reference_text.content_id = ? AND content.user_id = ? ORDER BY reference_text.created_at, reference_text.id`,
  );

  return {
    insert(ownerUserId, text) {
      if (ownedContent.get(text.contentId, ownerUserId) === undefined) {
        throw notFound("content", text.contentId);
      }
      insert.run({ ...text });
    },
    listByContent(ownerUserId, contentId) {
      return (byContent.all(contentId, ownerUserId) as ReferenceTextRow[]).map((row) => ({
        id: row.id,
        contentId: row.content_id,
        origin: row.origin,
        text: row.text,
        createdAt: row.created_at,
      }));
    },
  };
}
