import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../../../src/server/adapters/sqlite/database.ts";
import { latestSchemaVersion, MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { insertRow, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;

describe("migration 0010: paragraph starts", () => {
  it("adds a nullable 0 / 1 column, leaving existing sentences unparagraphed", () => {
    const dir = tempDataDir();
    const file = join(dir, "amber.db");
    const { db: v9 } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 9) });
    insertRow(v9, "user", { id: "u", role: "user", status: "active", created_at: T0 });
    insertRow(v9, "content", { id: "c", user_id: "u", source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
    insertRow(v9, "transcript_revision", {
      id: "r", content_id: "c", kind: "asr", language: "zh-CN", timing_fidelity: "exact_words", generation_json: "{}", segment_count: 1, created_at: T0,
    });
    insertRow(v9, "transcript_segment", { id: "s0", revision_id: "r", ordinal: 0, start_ms: 0, end_ms: 1000, text: "旧句" });
    v9.close();

    const { db, from, to } = openDatabase(file, { backupDir: join(dir, "backups") });
    expect({ from, to }).toEqual({ from: 9, to: latestSchemaVersion() });
    expect(db.prepare("SELECT paragraph_start FROM transcript_segment WHERE id = 's0'").get()).toEqual({ paragraph_start: null });
    const segment = (id: string, paragraphStart: number) =>
      insertRow(db, "transcript_segment", { id, revision_id: "r", ordinal: Number(id.slice(1)), start_ms: 0, end_ms: 1000, text: "新句", paragraph_start: paragraphStart });
    segment("s1", 1);
    segment("s2", 0);
    expect(() => segment("s3", 2)).toThrow(/CHECK/);
    db.close();
  });
});
