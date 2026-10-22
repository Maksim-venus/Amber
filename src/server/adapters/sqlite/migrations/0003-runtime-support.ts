import type { Migration } from "../migrations.ts";

/**
 * Runtime support needed by the task API: `IdempotencyRecord` and the single-row
 * `InstanceSettings`, plus the frozen per-attempt stage input (`StageRun.inputJson`).
 *
 * The instance settings row is written by the application at start-up from the named
 * defaults, so no default value is restated in SQL. Range checks here are structural
 * invariants, not defaults.
 */
export const migration0003: Migration = {
  version: 3,
  name: "runtime-support",
  sql: `
    CREATE TABLE idempotency_record (
      user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
      route TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      response_status INTEGER NOT NULL,
      response_body_json TEXT NOT NULL CHECK (json_valid(response_body_json)),
      resource_refs_json TEXT NOT NULL CHECK (json_valid(resource_refs_json)),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, route, idempotency_key)
    ) STRICT;

    -- Instance-level: a single row with no owner.
    CREATE TABLE instance_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      concurrency_heavy INTEGER NOT NULL CHECK (concurrency_heavy >= 1),
      concurrency_pipeline INTEGER NOT NULL CHECK (concurrency_pipeline >= 1),
      concurrency_llm INTEGER NOT NULL CHECK (concurrency_llm >= 1),
      max_data_gb REAL NOT NULL CHECK (max_data_gb > 0),
      low_water_free_gb REAL NOT NULL CHECK (low_water_free_gb > 0),
      low_water_free_ratio REAL NOT NULL CHECK (low_water_free_ratio >= 0 AND low_water_free_ratio <= 1),
      upload_retention_default TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;

    ALTER TABLE stage_run ADD COLUMN input_json TEXT CHECK (input_json IS NULL OR json_valid(input_json));
    CREATE TRIGGER stage_run_input_immutable BEFORE UPDATE OF input_json ON stage_run
    WHEN old.input_json IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'stage_run.input_json is immutable');
    END;

    -- The scheduler's queue: unfinished Tasks in FIFO order.
    CREATE INDEX task_unfinished ON task (created_at, id) WHERE finished_at IS NULL;
  `,
};
