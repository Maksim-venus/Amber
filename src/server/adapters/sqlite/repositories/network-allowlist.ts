import type { NetworkAllowlistEntry } from "../../../domain/runtime-support.ts";
import type { NetworkAllowlistRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { nullable, withoutNulls } from "./rows.ts";

interface AllowlistRow {
  origin: string;
  created_by_user_id: string | null;
  created_at: number;
}

export function sqliteNetworkAllowlistRepository(db: SqliteConnection): NetworkAllowlistRepository {
  const selectAll = db.prepare("SELECT * FROM network_allowlist ORDER BY origin");
  const clear = db.prepare("DELETE FROM network_allowlist");
  const insert = db.prepare(
    "INSERT INTO network_allowlist (origin, created_by_user_id, created_at) VALUES (@origin, @createdByUserId, @createdAt)",
  );
  return {
    list() {
      return (selectAll.all() as AllowlistRow[]).map((row) =>
        withoutNulls<NetworkAllowlistEntry>({ origin: row.origin, createdByUserId: row.created_by_user_id, createdAt: row.created_at }),
      );
    },
    replace(entries) {
      clear.run();
      for (const entry of entries) {
        insert.run({ origin: entry.origin, createdByUserId: nullable(entry.createdByUserId), createdAt: entry.createdAt });
      }
    },
  };
}
