import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { latestSchemaVersion, MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { NOTE_COLORS, NOTE_MARKS } from "../../../../../src/shared/enums.ts";
import { countRows, insertRow, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;

/** Two users; `c1` (u1) has revisions `r1` (segments s1, s2) and `r2` (segment s3); `c2` (u1) has `r3` (s4); `c3` belongs to u2. */
function seedV14(db: SqliteConnection): void {
  for (const id of ["u1", "u2"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
  for (const [id, user] of [["c1", "u1"], ["c2", "u1"], ["c3", "u2"]]) {
    insertRow(db, "content", { id, user_id: user, source_kind: "local", processing_status: "succeeded", created_at: T0, updated_at: T0 });
  }
  for (const [id, content] of [["r1", "c1"], ["r2", "c1"], ["r3", "c2"]]) {
    insertRow(db, "transcript_revision", {
      id, content_id: content, kind: "asr", language: "zh-CN", timing_fidelity: "exact_words", generation_json: "{}", segment_count: 1, created_at: T0,
    });
  }
  for (const [id, revision, ordinal] of [["s1", "r1", 0], ["s2", "r1", 1], ["s3", "r2", 0], ["s4", "r3", 0]] as const) {
    insertRow(db, "transcript_segment", { id, revision_id: revision, ordinal, start_ms: ordinal * 1000, end_ms: ordinal * 1000 + 1000, text: "第一句。" });
  }
}

const note = (overrides: Record<string, unknown> = {}) => ({
  id: "n1", user_id: "u1", content_id: "c1", transcript_revision_id: "r1", start_segment_id: "s1", start_offset: 0,
  end_segment_id: "s2", end_offset: 2, quote: "第一句。第一", mark: "background", color: "yellow", created_at: T0, updated_at: T0,
  ...overrides,
});

let db: SqliteConnection;

beforeEach(() => {
  const dir = tempDataDir();
  const file = join(dir, "amber.db");
  const { db: v14 } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 14) });
  seedV14(v14);
  v14.close();
  const opened = openDatabase(file, { backupDir: join(dir, "backups") });
  expect({ from: opened.from, to: opened.to }).toEqual({ from: 14, to: latestSchemaVersion() });
  db = opened.db;
});

describe("migration 0015: notes", () => {
  it("keeps existing transcripts intact and adds an empty note table", () => {
    expect(countRows(db, "transcript_segment")).toBe(4);
    expect(countRows(db, "note")).toBe(0);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'transcript_segment'").all();
    expect(indexes).toContainEqual({ name: "transcript_segment_id_revision" });
  });

  it("accepts every mark and colour of the shared enums and nothing else", () => {
    NOTE_MARKS.forEach((mark, m) => NOTE_COLORS.forEach((color, c) => insertRow(db, "note", note({ id: `n-${m}-${c}`, mark, color }))));
    expect(countRows(db, "note")).toBe(NOTE_MARKS.length * NOTE_COLORS.length);
    expect(() => insertRow(db, "note", note({ mark: "strike" }))).toThrow(/CHECK/);
    expect(() => insertRow(db, "note", note({ color: "red" }))).toThrow(/CHECK/);
    expect(() => insertRow(db, "note", note({ start_offset: -1 }))).toThrow(/CHECK/);
    expect(() => insertRow(db, "note", note({ end_offset: 0 }))).toThrow(/CHECK/);
  });

  it("keeps the revision within the Content, both sentences within the revision and the Content within the owner", () => {
    insertRow(db, "note", note());
    expect(() => insertRow(db, "note", note({ id: "x1", transcript_revision_id: "r3" }))).toThrow(/FOREIGN KEY/);
    expect(() => insertRow(db, "note", note({ id: "x2", start_segment_id: "s3" }))).toThrow(/FOREIGN KEY/);
    expect(() => insertRow(db, "note", note({ id: "x3", end_segment_id: "s4" }))).toThrow(/FOREIGN KEY/);
    expect(() => insertRow(db, "note", note({ id: "x4", user_id: "u2" }))).toThrow(/FOREIGN KEY/);
    expect(() => insertRow(db, "note", note({ id: "x5", content_id: "c3", user_id: "u2" }))).toThrow(/FOREIGN KEY/);
  });

  it("freezes the anchor and quote but lets mark, colour and comment change", () => {
    insertRow(db, "note", note());
    for (const [column, value] of [
      ["user_id", "u2"], ["content_id", "c2"], ["transcript_revision_id", "r2"], ["start_segment_id", "s2"], ["start_offset", 1],
      ["end_segment_id", "s1"], ["end_offset", 1], ["quote", "x"], ["created_at", T0 + 1],
    ] as const) {
      expect(() => db.prepare(`UPDATE note SET ${column} = ? WHERE id = 'n1'`).run(value), column).toThrow(/immutable/);
    }
    db.prepare("UPDATE note SET mark = 'underline', color = 'blue', comment = 'later', updated_at = ? WHERE id = 'n1'").run(T0 + 5);
    expect(db.prepare("SELECT mark, color, comment, updated_at AS updatedAt FROM note").get()).toEqual({ mark: "underline", color: "blue", comment: "later", updatedAt: T0 + 5 });
  });

  it("goes with its Content and with its owner", () => {
    insertRow(db, "note", note());
    insertRow(db, "note", note({ id: "n2", content_id: "c2", transcript_revision_id: "r3", start_segment_id: "s4", end_segment_id: "s4" }));
    db.prepare("DELETE FROM content WHERE id = 'c1'").run();
    expect(db.prepare("SELECT id FROM note").all()).toEqual([{ id: "n2" }]);
    expect(countRows(db, "transcript_segment", "revision_id IN ('r1', 'r2')")).toBe(0);
    db.prepare("DELETE FROM user WHERE id = 'u1'").run();
    expect(countRows(db, "note")).toBe(0);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
