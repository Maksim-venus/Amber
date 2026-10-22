import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, type SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { MIGRATIONS } from "../../../../../src/server/adapters/sqlite/migrations.ts";
import { countRows, insertRow, tempDataDir } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
const json = (value: unknown): string => JSON.stringify(value);

/** One user at schema 17: two ASR profiles with ordered models, a default, usage linked to both, and an LLM model. */
function seedUser(db: SqliteConnection, userId: string): void {
  insertRow(db, "user", { id: userId, role: "user", status: "active", created_at: T0 });
  insertRow(db, "user_settings", {
    user_id: userId, theme: "light", language: "zh-CN", shortcuts_json: "{}", updated_at: T0,
    default_asr_model_ref_json: json({ asrProfileId: `d-${userId}`, modelId: "fun-asr" }),
  });
  insertRow(db, "asr_provider_profile", {
    id: `d-${userId}`, user_id: userId, name: "百炼", provider: "dashscope", models_json: json(["fun-asr", "qwen-audio-3.1-asr-flash-filetrans"]), created_at: T0, position: 0,
  });
  insertRow(db, "asr_provider_profile", {
    id: `e-${userId}`, user_id: userId, name: "ElevenLabs", provider: "elevenlabs", models_json: json(["scribe_v2_medical", "scribe_v2"]), created_at: T0 + 1, position: 1,
  });
  for (const [index, profileId] of [`d-${userId}`, `e-${userId}`, `e-${userId}`].entries()) {
    insertRow(db, "asr_usage", {
      id: `u${index}-${userId}`, user_id: userId, asr_profile_id: profileId, provider: "dashscope", model: "fun-asr",
      outcome: "succeeded", audio_ms: 60_000, created_at: T0 + index,
    });
  }
  insertRow(db, "provider_profile", { id: `p-${userId}`, user_id: userId, name: "relay", protocol: "openai_compatible", base_url: "https://llm.invalid/v1", created_at: T0 });
  insertRow(db, "model_capability", { profile_id: `p-${userId}`, model_id: "m", position: 0, flags_declared_json: "{}", limits_declared_json: "{}" });
}

function atVersion17(): { dir: string; file: string } {
  const dir = tempDataDir();
  const file = join(dir, "amber.db");
  const { db } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 17) });
  seedUser(db, "alice");
  seedUser(db, "bob");
  db.close();
  return { dir, file };
}

const migrate = (dir: string, file: string) => openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 18) });

describe("migration 0018: model prices, ASR model entries, usage feature and other models", () => {
  it("turns each ASR model id into an entry in the same order, leaving profiles, defaults and usage links alone", () => {
    const { dir, file } = atVersion17();
    const { db, from, to } = migrate(dir, file);
    expect({ from, to }).toEqual({ from: 17, to: 18 });
    expect(db.prepare("SELECT id, models_json FROM asr_provider_profile ORDER BY id").all()).toEqual([
      { id: "d-alice", models_json: json([{ modelId: "fun-asr" }, { modelId: "qwen-audio-3.1-asr-flash-filetrans" }]) },
      { id: "d-bob", models_json: json([{ modelId: "fun-asr" }, { modelId: "qwen-audio-3.1-asr-flash-filetrans" }]) },
      { id: "e-alice", models_json: json([{ modelId: "scribe_v2_medical" }, { modelId: "scribe_v2" }]) },
      { id: "e-bob", models_json: json([{ modelId: "scribe_v2_medical" }, { modelId: "scribe_v2" }]) },
    ]);
    expect(db.prepare("SELECT user_id, default_asr_model_ref_json FROM user_settings ORDER BY user_id").all()).toEqual([
      { user_id: "alice", default_asr_model_ref_json: json({ asrProfileId: "d-alice", modelId: "fun-asr" }) },
      { user_id: "bob", default_asr_model_ref_json: json({ asrProfileId: "d-bob", modelId: "fun-asr" }) },
    ]);
    expect(countRows(db, "asr_usage")).toBe(6);
    expect(countRows(db, "asr_usage", "asr_profile_id IS NOT NULL")).toBe(6);
    expect(db.prepare("SELECT DISTINCT feature FROM asr_usage").all()).toEqual([{ feature: "transcribe" }]);
    expect(db.prepare("SELECT pricing_json FROM model_capability").all()).toEqual([{ pricing_json: null }, { pricing_json: null }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });

  it("checks the new columns: usage feature values, valid price JSON", () => {
    const { dir, file } = atVersion17();
    const { db } = migrate(dir, file);
    const usage = (id: string, extra: Record<string, unknown>) =>
      insertRow(db, "asr_usage", { id, user_id: "alice", provider: "dashscope", model: "fun-asr", outcome: "succeeded", audio_ms: 2000, created_at: T0, ...extra });
    usage("test", { feature: "test_connection" });
    usage("plain", {});
    expect(db.prepare("SELECT id, feature FROM asr_usage WHERE id IN ('test', 'plain') ORDER BY id").all()).toEqual([
      { id: "plain", feature: "transcribe" },
      { id: "test", feature: "test_connection" },
    ]);
    expect(() => usage("bad", { feature: "probe" })).toThrow(/CHECK/);
    expect(() => usage("null", { feature: null })).toThrow(/NOT NULL/);
    db.prepare("UPDATE model_capability SET pricing_json = ? WHERE profile_id = 'p-alice'").run(json({ currency: "CNY", items: [{ unit: "per_request", amount: "1" }] }));
    expect(() => db.prepare("UPDATE model_capability SET pricing_json = '{oops' WHERE profile_id = 'p-bob'").run()).toThrow(/CHECK/);
    db.close();
  });

  it("creates the other-models register: array models only, deleted with its user", () => {
    const { dir, file } = atVersion17();
    const { db } = migrate(dir, file);
    const models = json([{ modelId: "cosyvoice-v2", kind: "tts" }]);
    insertRow(db, "other_model_profile", { id: "o-alice", user_id: "alice", name: "百炼", models_json: models, created_at: T0 });
    insertRow(db, "other_model_profile", { id: "o-bob", user_id: "bob", name: "百炼", note: "备注", models_json: "[]", position: 1, created_at: T0 });
    expect(db.prepare("SELECT id, note, position FROM other_model_profile ORDER BY id").all()).toEqual([
      { id: "o-alice", note: null, position: 0 },
      { id: "o-bob", note: "备注", position: 1 },
    ]);
    expect(() => insertRow(db, "other_model_profile", { id: "x", user_id: "alice", name: "x", models_json: "{}", created_at: T0 })).toThrow(/CHECK/);
    expect(() => insertRow(db, "other_model_profile", { id: "y", user_id: "alice", name: "", models_json: "[]", created_at: T0 })).toThrow(/CHECK/);
    expect(() => insertRow(db, "other_model_profile", { id: "z", user_id: "nobody", name: "z", models_json: "[]", created_at: T0 })).toThrow(/FOREIGN KEY/);
    db.prepare("DELETE FROM user WHERE id = 'alice'").run();
    expect(db.prepare("SELECT id FROM other_model_profile").all()).toEqual([{ id: "o-bob" }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("rolls back as a whole when a step fails: the schema stays at 17 with string model lists", () => {
    const { dir, file } = atVersion17();
    const { db: v17 } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 17) });
    v17.exec("CREATE TRIGGER fail_0018 BEFORE UPDATE ON asr_provider_profile BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
    v17.close();
    expect(() => migrate(dir, file)).toThrow(/injected failure/);

    const { db } = openDatabase(file, { backupDir: join(dir, "backups"), migrations: MIGRATIONS.slice(0, 17) });
    expect(db.pragma("user_version", { simple: true })).toBe(17);
    expect(db.prepare("SELECT models_json FROM asr_provider_profile WHERE id = 'e-alice'").get()).toEqual({ models_json: json(["scribe_v2_medical", "scribe_v2"]) });
    expect((db.prepare("SELECT name FROM pragma_table_info('model_capability')").all() as Array<{ name: string }>).map((row) => row.name)).not.toContain("pricing_json");
    expect(countRows(db, "sqlite_master", "name = 'other_model_profile'")).toBe(0);
    db.close();
  });
});
