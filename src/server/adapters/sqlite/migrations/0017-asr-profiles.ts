import type { Migration } from "../migrations.ts";

/**
 * Several ASR profiles per user, each with several models.
 * The table is rebuilt without `UNIQUE (user_id)`; its single `model` becomes the ordered
 * `models_json` list, and it gains `name`, `created_at` and the user's `position`. Ids,
 * credential references and Secrets are kept, so nothing has to be configured again. The
 * existing profile is named after its provider and dated by its Secret, else by its user.
 *
 * Dropping the old table runs an implicit delete that would set `asr_usage.asr_profile_id`
 * to NULL, so the links are saved first and restored onto the same ids.
 *
 * `user_settings.default_asr_model_ref_json` starts empty for everyone, as
 * `default_model_ref_json` does: a default is only ever set by the user.
 * Like it, the reference is plain JSON: the service clears it when its profile or model
 * goes, and checks ownership on every write and read.
 *
 * Every ASR stage run that has run or may still run, and has no frozen input, is bound to
 * the model it used or would have used: that of the user's only profile. Unfinished Tasks
 * thus carry on unchanged, failed ones can be re-run without choosing again, and finished
 * ones keep naming their engine. Skipped stages never ran and stay unbound.
 */
export const migration0017: Migration = {
  version: 17,
  name: "asr-profiles",
  sql: `
    CREATE TEMP TABLE asr_usage_profile_link AS
      SELECT id, asr_profile_id FROM asr_usage WHERE asr_profile_id IS NOT NULL;

    CREATE TABLE asr_provider_profile_v17 (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (length(name) > 0),
      provider TEXT NOT NULL,
      models_json TEXT NOT NULL CHECK (json_valid(models_json) AND json_type(models_json) = 'array' AND json_array_length(models_json) > 0),
      credential_ref TEXT UNIQUE,
      base_url TEXT,
      provider_config_json TEXT CHECK (provider_config_json IS NULL OR json_valid(provider_config_json)),
      created_at INTEGER NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (credential_ref, user_id) REFERENCES secret (id, user_id)
    ) STRICT;
    INSERT INTO asr_provider_profile_v17
      (id, user_id, name, provider, models_json, credential_ref, base_url, provider_config_json, created_at, position)
    SELECT
      p.id, p.user_id,
      CASE p.provider WHEN 'elevenlabs' THEN 'ElevenLabs' ELSE p.provider END,
      p.provider, json_array(p.model), p.credential_ref, p.base_url, p.provider_config_json,
      coalesce((SELECT s.created_at FROM secret AS s WHERE s.id = p.credential_ref), (SELECT u.created_at FROM user AS u WHERE u.id = p.user_id)),
      0
    FROM asr_provider_profile AS p;

    DROP TABLE asr_provider_profile;
    ALTER TABLE asr_provider_profile_v17 RENAME TO asr_provider_profile;
    CREATE INDEX asr_provider_profile_user ON asr_provider_profile (user_id, position, created_at, id);
    CREATE TRIGGER asr_provider_profile_secret_delete AFTER DELETE ON asr_provider_profile
    WHEN old.credential_ref IS NOT NULL
    BEGIN
      DELETE FROM secret WHERE id = old.credential_ref;
    END;

    UPDATE asr_usage SET asr_profile_id = (SELECT link.asr_profile_id FROM asr_usage_profile_link AS link WHERE link.id = asr_usage.id)
    WHERE id IN (SELECT id FROM asr_usage_profile_link);
    DROP TABLE asr_usage_profile_link;

    ALTER TABLE user_settings ADD COLUMN default_asr_model_ref_json TEXT
      CHECK (default_asr_model_ref_json IS NULL OR json_valid(default_asr_model_ref_json));

    UPDATE stage_run
    SET input_json = (
      SELECT json_object('asrModelRef', json_object('asrProfileId', p.id, 'modelId', json_extract(p.models_json, '$[0]')))
      FROM task AS t JOIN asr_provider_profile AS p ON p.user_id = t.user_id WHERE t.id = stage_run.task_id
    )
    WHERE stage = 'asr'
      AND input_json IS NULL
      AND status <> 'skipped'
      AND EXISTS (SELECT 1 FROM task AS t JOIN asr_provider_profile AS p ON p.user_id = t.user_id WHERE t.id = stage_run.task_id);
  `,
};
