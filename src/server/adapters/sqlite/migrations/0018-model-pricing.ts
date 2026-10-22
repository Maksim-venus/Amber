import type { Migration } from "../migrations.ts";

/**
 * User-entered model prices, typed-in ASR models and the register of other models.
 *
 * - `model_capability.pricing_json`: the user's price of an LLM model, display only.
 * - `asr_provider_profile.models_json` turns from model ids into entries `{ modelId, … }`,
 *   order kept. Entries written here name no family: every stored model is one the
 *   provider knows by id, so its family resolves when read; a typed-in model is always
 *   saved with its family.
 * - `asr_usage.feature` tells a Task's transcription from a model test; every existing row
 *   is a transcription.
 * - `other_model_profile`: models Amber does not call, with kind and price; no key, no
 *   address, deleted with their user.
 */
export const migration0018: Migration = {
  version: 18,
  name: "model-pricing",
  sql: `
    ALTER TABLE model_capability ADD COLUMN pricing_json TEXT CHECK (pricing_json IS NULL OR json_valid(pricing_json));

    UPDATE asr_provider_profile SET models_json = (
      SELECT json_group_array(json_object('modelId', ids.value))
      FROM (SELECT value FROM json_each(asr_provider_profile.models_json) ORDER BY key) AS ids
    );

    ALTER TABLE asr_usage ADD COLUMN feature TEXT NOT NULL DEFAULT 'transcribe' CHECK (feature IN ('transcribe', 'test_connection'));

    CREATE TABLE other_model_profile (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (length(name) > 0),
      note TEXT,
      models_json TEXT NOT NULL CHECK (json_valid(models_json) AND json_type(models_json) = 'array'),
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX other_model_profile_user ON other_model_profile (user_id, position, created_at, id);
  `,
};
