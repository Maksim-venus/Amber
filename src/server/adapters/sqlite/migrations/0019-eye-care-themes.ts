import type { Migration } from "../migrations.ts";

/**
 * `user_settings` without the member CHECKs on `theme` and `platform_cookie_browser`, so
 * that the eye-care themes can be stored. Those value sets belong to the
 * API boundary schemas and, as for every enumerated column since 0002,
 * SQL only enforces structural invariants; SQLite cannot alter a CHECK in place, so the
 * table is rebuilt once and later members need no further migration.
 *
 * Every other column, its order, the keys, the NOT NULLs and the JSON checks are kept as
 * they are, and rows are copied unchanged. No index, trigger or foreign key points at the
 * table, so dropping the old one affects nothing else even with foreign keys enforced.
 */
export const migration0019: Migration = {
  version: 19,
  name: "eye-care-themes",
  sql: `
    CREATE TABLE user_settings_v19 (
      user_id TEXT PRIMARY KEY REFERENCES user (id) ON DELETE CASCADE,
      theme TEXT NOT NULL,
      language TEXT NOT NULL,
      default_summary_template_id TEXT REFERENCES summary_template (id) ON DELETE SET NULL,
      shortcuts_json TEXT NOT NULL CHECK (json_valid(shortcuts_json)),
      chat_model_ref_json TEXT CHECK (chat_model_ref_json IS NULL OR json_valid(chat_model_ref_json)),
      default_model_ref_json TEXT CHECK (default_model_ref_json IS NULL OR json_valid(default_model_ref_json)),
      default_output_language TEXT,
      platform_cookie_browser TEXT,
      updated_at INTEGER NOT NULL,
      default_asr_model_ref_json TEXT CHECK (default_asr_model_ref_json IS NULL OR json_valid(default_asr_model_ref_json))
    ) STRICT;
    INSERT INTO user_settings_v19
      (user_id, theme, language, default_summary_template_id, shortcuts_json, chat_model_ref_json,
       default_model_ref_json, default_output_language, platform_cookie_browser, updated_at, default_asr_model_ref_json)
    SELECT
      user_id, theme, language, default_summary_template_id, shortcuts_json, chat_model_ref_json,
      default_model_ref_json, default_output_language, platform_cookie_browser, updated_at, default_asr_model_ref_json
    FROM user_settings;

    DROP TABLE user_settings;
    ALTER TABLE user_settings_v19 RENAME TO user_settings;
  `,
};
