import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, type SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { countRows, insertRow, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
const json = (value: unknown): string => JSON.stringify(value);

/** One user at schema 16: a profile with a Secret, usage linked to it, and ASR stage runs in every relevant state. */
function seedUser(db: SqliteConnection, userId: string, offset: number): void {
  insertRow(db, "user", { id: userId, role: "user", status: "active", created_at: T0 });
  insertRow(db, "user_settings", { user_id: userId, theme: "light", language: "zh-CN", shortcuts_json: "{}", updated_at: T0 });
  insertRow(db, "secret", {
    id: `s-${userId}`, user_id: userId, envelope_version: 1, kdf_salt: Buffer.alloc(16, 1), nonce: Buffer.alloc(12, 2),
    ciphertext: Buffer.from([3, 4, 5]), auth_tag: Buffer.alloc(16, 6), created_at: T0 + offset, updated_at: T0 + offset,
  });
  insertRow(db, "asr_provider_profile", { id: `a-${userId}`, user_id: userId, provider: "elevenlabs", model: "scribe_v2", credential_ref: `s-${userId}` });
  insertRow(db, "content", { id: `c-${userId}`, user_id: userId, source_kind: "local", processing_status: "running", created_at: T0, updated_at: T0 });
  insertRow(db, "task", {
    id: `t-${userId}`, user_id: userId, content_id: `c-${userId}`, kind: "process_content",
    request_json: json({ requestSchemaVersion: 1, kind: "process_content", autoProofread: true }), status_projection: "running", created_at: T0,
  });
  const run = (id: string, stage: string, attempt: number, status: string, inputJson?: string) =>
    insertRow(db, "stage_run", {
      id: `${id}-${userId}`, task_id: `t-${userId}`, stage, attempt, status, progress: 0, dependencies_json: "[]",
      ...(inputJson === undefined ? {} : { input_json: inputJson }),
    });
  run("asr-failed", "asr", 1, "failed");
  run("asr-running", "asr", 2, "running");
  run("asr-skipped", "asr", 3, "skipped");
  run("asr-bound", "asr", 4, "pending", json({ asrModelRef: { asrProfileId: "kept", modelId: "kept-model" } }));
  run("proofread", "proofread", 1, "pending");
  insertRow(db, "asr_usage", {
    id: `u-${userId}`, user_id: userId, asr_profile_id: `a-${userId}`, provider: "elevenlabs", model: "scribe_v2",
    outcome: "succeeded", audio_ms: 60_000, task_id: `t-${userId}`, created_at: T0,
  });
}

function atVersion16(): { dir: string; file: string } {
  const dir = tempDataDir();
  const file = join(dir, "amber.db");
  const { db } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 16) });
  seedUser(db, "alice", 1);
  seedUser(db, "bob", 2);
  db.close();
  return { dir, file };
}

const inputOf = (db: SqliteConnection, id: string): unknown => (db.prepare("SELECT input_json FROM stage_run WHERE id = ?").get(id) as { input_json: string | null }).input_json;

describe("migration 0017: several ASR profiles per user, each with several models", () => {
  it("keeps every profile, Secret and usage link, turns the model into a list, names, dates and positions the profile, and sets no default", () => {
    const { dir, file } = atVersion16();
    const { db, from, to } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 17) });
    expect({ from, to }).toEqual({ from: 16, to: 17 });
    expect(db.prepare("SELECT id, user_id, name, provider, models_json, credential_ref, base_url, created_at, position FROM asr_provider_profile ORDER BY id").all()).toEqual([
      { id: "a-alice", user_id: "alice", name: "ElevenLabs", provider: "elevenlabs", models_json: '["scribe_v2"]', credential_ref: "s-alice", base_url: null, created_at: T0 + 1, position: 0 },
      { id: "a-bob", user_id: "bob", name: "ElevenLabs", provider: "elevenlabs", models_json: '["scribe_v2"]', credential_ref: "s-bob", base_url: null, created_at: T0 + 2, position: 0 },
    ]);
    expect(countRows(db, "secret")).toBe(2);
    expect(db.prepare("SELECT id, asr_profile_id FROM asr_usage ORDER BY id").all()).toEqual([
      { id: "u-alice", asr_profile_id: "a-alice" },
      { id: "u-bob", asr_profile_id: "a-bob" },
    ]);
    expect(db.prepare("SELECT user_id, default_asr_model_ref_json FROM user_settings ORDER BY user_id").all()).toEqual([
      { user_id: "alice", default_asr_model_ref_json: null },
      { user_id: "bob", default_asr_model_ref_json: null },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_temp_master WHERE name = 'asr_usage_profile_link'").all()).toEqual([]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("binds each user's unbound ASR stage runs to that user's profile and model, leaving skipped and already bound runs alone", () => {
    const { dir, file } = atVersion16();
    const { db } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 17) });
    for (const user of ["alice", "bob"]) {
      const bound = json({ asrModelRef: { asrProfileId: `a-${user}`, modelId: "scribe_v2" } });
      expect(inputOf(db, `asr-failed-${user}`)).toBe(bound);
      expect(inputOf(db, `asr-running-${user}`)).toBe(bound);
      expect(inputOf(db, `asr-skipped-${user}`)).toBeNull();
      expect(inputOf(db, `asr-bound-${user}`)).toBe(json({ asrModelRef: { asrProfileId: "kept", modelId: "kept-model" } }));
      expect(inputOf(db, `proofread-${user}`)).toBeNull();
    }
    db.close();
  });

  it("allows several profiles per user with model lists, cascades with the user and deletes the Secret", () => {
    const { dir, file } = atVersion16();
    const { db } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 17) });
    insertRow(db, "asr_provider_profile", { id: "a2-alice", user_id: "alice", name: "百炼", provider: "dashscope", models_json: '["fun-asr","qwen-audio-3.1-asr-flash-filetrans"]', created_at: T0 + 5 });
    expect(countRows(db, "asr_provider_profile", "user_id = 'alice'")).toBe(2);
    expect(() => insertRow(db, "asr_provider_profile", { id: "empty", user_id: "alice", name: "x", provider: "dashscope", models_json: "[]", created_at: T0 })).toThrow(/CHECK/);
    db.prepare("DELETE FROM asr_provider_profile WHERE id = 'a-bob'").run();
    expect(countRows(db, "secret", "id = 's-bob'")).toBe(0);
    expect(db.prepare("SELECT asr_profile_id FROM asr_usage WHERE id = 'u-bob'").get()).toEqual({ asr_profile_id: null });

    db.prepare("DELETE FROM user WHERE id = 'alice'").run();
    expect(countRows(db, "asr_provider_profile", "user_id = 'alice'")).toBe(0);
    expect(countRows(db, "user", "id = 'bob'")).toBe(1);
    expect(countRows(db, "asr_usage", "id = 'u-bob'")).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("rolls back as a whole when a step fails: the schema stays at 16 with the old table and rows", () => {
    const { dir, file } = atVersion16();
    const { db: v16 } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 16) });
    v16.exec("CREATE TRIGGER fail_0017 BEFORE UPDATE ON stage_run BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
    v16.close();
    expect(() => openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 17) })).toThrow(/injected failure/);

    const { db } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 16) });
    expect(db.pragma("user_version", { simple: true })).toBe(16);
    const columns = (db.prepare("SELECT name FROM pragma_table_info('asr_provider_profile')").all() as Array<{ name: string }>).map((row) => row.name);
    expect(columns).not.toContain("name");
    expect(db.prepare("SELECT id, credential_ref FROM asr_provider_profile ORDER BY id").all()).toEqual([
      { id: "a-alice", credential_ref: "s-alice" },
      { id: "a-bob", credential_ref: "s-bob" },
    ]);
    expect(db.prepare("SELECT id, asr_profile_id FROM asr_usage ORDER BY id").all()).toEqual([
      { id: "u-alice", asr_profile_id: "a-alice" },
      { id: "u-bob", asr_profile_id: "a-bob" },
    ]);
    expect((db.prepare("SELECT name FROM pragma_table_info('user_settings')").all() as Array<{ name: string }>).map((row) => row.name)).not.toContain(
      "default_asr_model_ref_json",
    );
    expect(inputOf(db, "asr-running-alice")).toBeNull();
    db.close();
  });
});
