import type { Migration } from "../migrations.ts";

/**
 * Per-user preferences (`UserSettings`), created lazily by the application
 * from the named defaults, so no default value is restated in SQL. Model references are
 * JSON so clearing one that points at a deleted Profile is a single statement. The
 * sentinel table of the start-up self-check page is dropped along with that page.
 */
export const migration0006: Migration = {
  version: 6,
  name: "user-settings",
  sql: `
    CREATE TABLE user_settings (
      user_id TEXT PRIMARY KEY REFERENCES user (id) ON DELETE CASCADE,
      theme TEXT NOT NULL CHECK (theme IN ('light', 'dark')),
      language TEXT NOT NULL,
      default_summary_template_id TEXT REFERENCES summary_template (id) ON DELETE SET NULL,
      shortcuts_json TEXT NOT NULL CHECK (json_valid(shortcuts_json)),
      chat_model_ref_json TEXT CHECK (chat_model_ref_json IS NULL OR json_valid(chat_model_ref_json)),
      default_model_ref_json TEXT CHECK (default_model_ref_json IS NULL OR json_valid(default_model_ref_json)),
      default_output_language TEXT,
      platform_cookie_browser TEXT CHECK (platform_cookie_browser IS NULL OR platform_cookie_browser IN ('firefox', 'chrome', 'edge')),
      updated_at INTEGER NOT NULL
    ) STRICT;

    DROP TABLE m0_sentinel;
  `,
};
