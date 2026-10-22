import type { ImportBatch } from "../../../domain/content.ts";
import type { ImportBatchRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";

interface ImportBatchRow {
  id: string;
  user_id: string;
  source_type: ImportBatch["sourceType"];
  total_items: number;
  created_at: number;
}

export function sqliteImportBatchRepository(db: SqliteConnection): ImportBatchRepository {
  const select = db.prepare("SELECT * FROM import_batch WHERE id = ? AND user_id = ?");
  const insert = db.prepare(
    `INSERT INTO import_batch (id, user_id, source_type, total_items, created_at)
     VALUES (@id, @userId, @sourceType, @totalItems, @createdAt)`,
  );

  return {
    get(ownerUserId, batchId) {
      const row = select.get(batchId, ownerUserId) as ImportBatchRow | undefined;
      return row === undefined
        ? undefined
        : { id: row.id, userId: row.user_id, sourceType: row.source_type, totalItems: row.total_items, createdAt: row.created_at };
    },
    insert(batch) {
      insert.run({ ...batch });
    },
  };
}
