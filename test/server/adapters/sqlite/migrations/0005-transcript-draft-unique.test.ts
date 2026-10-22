import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../../../src/server/adapters/sqlite/database.ts";
import { latestSchemaVersion, MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { insertRow, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;

describe("migration 0005: one transcript draft per Content", () => {
  it("keeps only the most recently saved of duplicate drafts, then refuses a second one", () => {
    const dir = tempDataDir();
    const file = join(dir, "amber.db");
    const { db: v4 } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 4) });
    insertRow(v4, "user", { id: "u", role: "user", status: "active", created_at: T0 });
    for (const id of ["c1", "c2"]) {
      insertRow(v4, "content", { id, user_id: "u", source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
      insertRow(v4, "transcript_revision", {
        id: `r-${id}`, content_id: id, kind: "asr", language: "zh-CN", timing_fidelity: "exact_words", generation_json: "{}", segment_count: 0, created_at: T0,
      });
    }
    const draft = (id: string, content: string, updatedAt: number) =>
      insertRow(v4, "transcript_draft", { id, content_id: content, base_revision_id: `r-${content}`, segments_json: "[]", updated_at: updatedAt });
    draft("old", "c1", T0);
    draft("newest", "c1", T0 + 2);
    draft("middle", "c1", T0 + 1);
    draft("only", "c2", T0);
    v4.close();

    const { db, from, to } = openDatabase(file, { backupDir: join(dir, "backups") });
    expect({ from, to }).toEqual({ from: 4, to: latestSchemaVersion() });
    expect(db.prepare("SELECT id FROM transcript_draft ORDER BY id").all()).toEqual([{ id: "newest" }, { id: "only" }]);
    expect(() => insertRow(db, "transcript_draft", { id: "again", content_id: "c2", base_revision_id: "r-c2", segments_json: "[]", updated_at: T0 })).toThrow(/UNIQUE/);
    db.close();
  });
});
