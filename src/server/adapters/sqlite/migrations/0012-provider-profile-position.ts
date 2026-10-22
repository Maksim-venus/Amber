import type { Migration } from "../migrations.ts";

/**
 * The user's order of their LLM Provider Profiles. Existing profiles are
 * numbered per user in their former `created_at, id` order, so nothing moves on upgrade.
 */
export const migration0012: Migration = {
  version: 12,
  name: "provider-profile-position",
  sql: `
    ALTER TABLE provider_profile ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
    UPDATE provider_profile SET position = (
      SELECT count(*) FROM provider_profile AS earlier
      WHERE earlier.user_id = provider_profile.user_id
        AND (earlier.created_at < provider_profile.created_at
          OR (earlier.created_at = provider_profile.created_at AND earlier.id < provider_profile.id))
    );
  `,
};
