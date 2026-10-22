import type { Migration } from "../migrations.ts";

/**
 * Marks WorkUnits whose work is a paid outbound call: crash recovery parks
 * them for the user's confirmation instead of re-running them. Existing units made no paid
 * calls, hence the `none` default.
 */
export const migration0004: Migration = {
  version: 4,
  name: "work-unit-billing",
  sql: `
    ALTER TABLE work_unit ADD COLUMN billing TEXT NOT NULL DEFAULT 'none' CHECK (billing IN ('none', 'asr', 'llm'));
  `,
};
