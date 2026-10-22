import type { Migration } from "../migrations.ts";

/**
 * One concurrency setting and system-paced retries. The heavy-work
 * and model-request limits are no longer settings, so their columns go; the dropped columns
 * carry only their own CHECK constraints and no index, which `DROP COLUMN` allows. Each
 * WorkUnit gains the count of its automatic retries, kept across stage re-runs and
 * restarts, and the earliest time it may run again.
 */
export const migration0013: Migration = {
  version: 13,
  name: "concurrency-settings",
  sql: `
    ALTER TABLE instance_settings DROP COLUMN concurrency_heavy;
    ALTER TABLE instance_settings DROP COLUMN concurrency_llm;
    ALTER TABLE work_unit ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0);
    ALTER TABLE work_unit ADD COLUMN retry_not_before INTEGER;
  `,
};
