import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../../../src/server/adapters/sqlite/database.ts";
import { latestSchemaVersion, MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { insertRow, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;

describe("migration 0014: when a Collection last changed", () => {
  it("backfills the latest of creation, a lecture joining and a rollup summary revision", () => {
    const dir = tempDataDir();
    const file = join(dir, "amber.db");
    const { db: v13 } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 13) });
    insertRow(v13, "user", { id: "u", role: "user", status: "active", created_at: T0 });
    insertRow(v13, "content", { id: "c", user_id: "u", source_kind: "local", title: "第一讲", processing_status: "succeeded", created_at: T0, updated_at: T0 });
    for (const id of ["empty", "joined", "summarized"]) {
      insertRow(v13, "collection", { id, user_id: "u", name: id, created_at: T0 });
    }
    insertRow(v13, "collection_item", { id: "i1", collection_id: "joined", content_id: "c", position: 0, added_at: T0 + 5 });
    insertRow(v13, "collection_item", { id: "i2", collection_id: "summarized", content_id: "c", position: 0, added_at: T0 + 5 });
    insertRow(v13, "collection_summary_artifact", { id: "a", collection_id: "summarized" });
    insertRow(v13, "collection_summary_revision", {
      id: "r",
      artifact_id: "a",
      inputs_json: "[]",
      quality: "normal",
      input_items_json: "[]",
      partial_ids_json: "[]",
      body: "",
      citations_json: "[]",
      created_at: T0 + 9,
    });
    v13.close();

    const { db, from, to } = openDatabase(file, { backupDir: join(dir, "backups") });
    expect({ from, to }).toEqual({ from: 13, to: latestSchemaVersion() });
    expect(db.prepare("SELECT id, updated_at AS updatedAt FROM collection ORDER BY id").all()).toEqual([
      { id: "empty", updatedAt: T0 },
      { id: "joined", updatedAt: T0 + 5 },
      { id: "summarized", updatedAt: T0 + 9 },
    ]);
    db.close();
  });
});
