import type { Migration } from "../migrations.ts";

/**
 * The domain schema (users, contents, collections, tasks, media assets, transcripts,
 * profiles, terminology, derived artifacts, chat and usage), the `WorkUnitResult` table and
 * the `Secret` table. The other runtime support tables arrive with later migrations.
 *
 * Conventions:
 * - Enumerated columns carry no CHECK of their members: value sets are validated in
 *   code, so growing an enum never needs a table rebuild. SQL only enforces structural
 *   invariants: JSON validity, timing spans, exactly-one targets, discriminant / column
 *   pairings, owner consistency and uniqueness.
 * - Invariant: every table can be traced to its owner; it has a
 *   `user_id` column, a non-null foreign-key chain to a table that has one, or a row
 *   invariant (`summary_template` builtin rows, `rollup_partial` exactly-one owner).
 * - Where a table has both its own `user_id` and a user-owned parent, a composite foreign
 *   key on `(parent_id, user_id)` makes cross-owner links impossible.
 * - Deletion cascades through ON DELETE actions and the triggers below, so a
 *   single `DELETE` of a User, Content or Collection leaves no dangling reference.
 * - Invariant: committed revisions are immutable; UPDATE is rejected by
 *   trigger, while deletion through the owning Content stays possible.
 */
export const migration0002: Migration = {
  version: 2,
  name: "domain-schema",
  sql: `
    -- Users -----------------------------------------------------------------------------

    CREATE TABLE user (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      display_name TEXT,
      storage_limit_gb REAL CHECK (storage_limit_gb IS NULL OR storage_limit_gb > 0),
      created_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE user_credential (
      user_id TEXT PRIMARY KEY REFERENCES user (id) ON DELETE CASCADE,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      must_change_password INTEGER NOT NULL CHECK (must_change_password IN (0, 1))
    ) STRICT;

    -- Secret envelopes (credentialRef == secret.id) -------------------------------------

    CREATE TABLE secret (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
      envelope_version INTEGER NOT NULL,
      kdf_salt BLOB NOT NULL CHECK (length(kdf_salt) = 16),
      nonce BLOB NOT NULL CHECK (length(nonce) = 12),
      ciphertext BLOB NOT NULL,
      auth_tag BLOB NOT NULL CHECK (length(auth_tag) = 16),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (id, user_id)
    ) STRICT;
    CREATE INDEX secret_user ON secret (user_id);

    -- Content ---------------------------------------------------------------------------

    CREATE TABLE import_batch (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      total_items INTEGER NOT NULL CHECK (total_items >= 0),
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX import_batch_user ON import_batch (user_id);

    CREATE TABLE content (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
      source_kind TEXT NOT NULL,
      source_url TEXT,
      platform_content_id TEXT,
      platform_part_id TEXT,
      platform_collection_id TEXT,
      channel_id TEXT,
      channel_title TEXT,
      title TEXT,
      cover_url TEXT,
      duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
      published_at INTEGER,
      raw_language TEXT,
      primary_transcript_revision_id TEXT,
      import_batch_id TEXT REFERENCES import_batch (id) ON DELETE SET NULL,
      processing_status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (id, user_id),
      -- The primary transcript must be a revision of this same Content.
      FOREIGN KEY (primary_transcript_revision_id, id) REFERENCES transcript_revision (id, content_id)
    ) STRICT;
    CREATE INDEX content_user_updated ON content (user_id, updated_at DESC);
    CREATE INDEX content_import_batch ON content (import_batch_id);
    CREATE INDEX content_primary_transcript ON content (primary_transcript_revision_id, id);
    -- Canonical platform identity (userId, platform, platformContentId, platformPartId ?? "").
    CREATE UNIQUE INDEX content_platform_identity
      ON content (user_id, source_kind, platform_content_id, coalesce(platform_part_id, ''))
      WHERE platform_content_id IS NOT NULL;

    -- Collections -----------------------------------------------------------------------

    CREATE TABLE collection (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      platform_collection_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (id, user_id)
    ) STRICT;
    CREATE INDEX collection_user ON collection (user_id);

    CREATE TABLE collection_item (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL REFERENCES collection (id) ON DELETE CASCADE,
      content_id TEXT NOT NULL REFERENCES content (id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      added_at INTEGER NOT NULL,
      UNIQUE (collection_id, content_id)
    ) STRICT;
    CREATE INDEX collection_item_content ON collection_item (content_id);

    -- Tasks -----------------------------------------------------------------------------

    CREATE TABLE task (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
      content_id TEXT,
      collection_id TEXT,
      kind TEXT NOT NULL,
      request_json TEXT NOT NULL CHECK (json_valid(request_json)),
      status_projection TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      CHECK ((content_id IS NULL) <> (collection_id IS NULL)),
      FOREIGN KEY (content_id, user_id) REFERENCES content (id, user_id) ON DELETE CASCADE,
      FOREIGN KEY (collection_id, user_id) REFERENCES collection (id, user_id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX task_user_created ON task (user_id, created_at);
    CREATE INDEX task_content ON task (content_id, user_id);
    CREATE INDEX task_collection ON task (collection_id, user_id);
    CREATE TRIGGER task_request_immutable BEFORE UPDATE OF request_json ON task
    BEGIN
      SELECT RAISE(ABORT, 'task.request_json is immutable');
    END;

    CREATE TABLE stage_run (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES task (id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt >= 0),
      status TEXT NOT NULL,
      progress REAL NOT NULL CHECK (progress >= 0 AND progress <= 1),
      dependencies_json TEXT NOT NULL CHECK (json_valid(dependencies_json)),
      condition_id TEXT,
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
      started_at INTEGER,
      finished_at INTEGER,
      UNIQUE (task_id, stage, attempt)
    ) STRICT;

    CREATE TABLE work_unit (
      id TEXT PRIMARY KEY,
      stage_run_id TEXT NOT NULL REFERENCES stage_run (id) ON DELETE CASCADE,
      unit_key TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt >= 0),
      input_digest TEXT NOT NULL,
      output_ref TEXT,
      output_digest TEXT,
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      UNIQUE (stage_run_id, unit_key)
    ) STRICT;

    CREATE TABLE work_unit_result (
      work_unit_id TEXT PRIMARY KEY REFERENCES work_unit (id) ON DELETE CASCADE,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      output_digest TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;

    -- Media assets ----------------------------------------------------------------------

    CREATE TABLE media_asset (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
      content_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      task_id TEXT REFERENCES task (id) ON DELETE CASCADE,
      storage_ref TEXT NOT NULL,
      display_name TEXT,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
      quality TEXT,
      fingerprint TEXT,
      acquisition TEXT,
      availability TEXT NOT NULL,
      retention_policy TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (content_id, user_id) REFERENCES content (id, user_id) ON DELETE CASCADE,
      -- Task-scoped kinds must name their Task; every other kind must not.
      CHECK ((task_id IS NOT NULL) = (kind IN ('extracted_audio', 'temporary')))
    ) STRICT;
    CREATE INDEX media_asset_content ON media_asset (content_id, user_id);
    CREATE INDEX media_asset_task ON media_asset (task_id);
    CREATE INDEX media_asset_fingerprint ON media_asset (user_id, fingerprint) WHERE fingerprint IS NOT NULL;

    -- Transcripts -----------------------------------------------------------------------

    CREATE TABLE transcript_revision (
      id TEXT PRIMARY KEY,
      content_id TEXT NOT NULL REFERENCES content (id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      parent_revision_id TEXT,
      language TEXT NOT NULL,
      timing_fidelity TEXT NOT NULL,
      generation_json TEXT NOT NULL CHECK (json_valid(generation_json)),
      segment_count INTEGER NOT NULL CHECK (segment_count >= 0),
      created_at INTEGER NOT NULL,
      UNIQUE (id, content_id),
      FOREIGN KEY (parent_revision_id, content_id) REFERENCES transcript_revision (id, content_id)
    ) STRICT;
    CREATE INDEX transcript_revision_content ON transcript_revision (content_id, created_at);
    CREATE INDEX transcript_revision_parent ON transcript_revision (parent_revision_id, content_id);

    CREATE TABLE transcript_segment (
      id TEXT PRIMARY KEY,
      revision_id TEXT NOT NULL REFERENCES transcript_revision (id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      text TEXT NOT NULL,
      words_json TEXT CHECK (words_json IS NULL OR json_valid(words_json)),
      speaker_id TEXT,
      CHECK (start_ms >= 0 AND start_ms < end_ms),
      UNIQUE (revision_id, ordinal)
    ) STRICT;

    CREATE TABLE transcript_segment_source (
      child_segment_id TEXT NOT NULL REFERENCES transcript_segment (id) ON DELETE CASCADE,
      parent_segment_id TEXT NOT NULL REFERENCES transcript_segment (id),
      position INTEGER NOT NULL CHECK (position >= 0),
      PRIMARY KEY (child_segment_id, position)
    ) STRICT;
    CREATE INDEX transcript_segment_source_parent ON transcript_segment_source (parent_segment_id);

    CREATE TABLE transcript_draft (
      id TEXT PRIMARY KEY,
      content_id TEXT NOT NULL REFERENCES content (id) ON DELETE CASCADE,
      base_revision_id TEXT NOT NULL,
      segments_json TEXT NOT NULL CHECK (json_valid(segments_json)),
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (base_revision_id, content_id) REFERENCES transcript_revision (id, content_id)
    ) STRICT;
    CREATE INDEX transcript_draft_content ON transcript_draft (content_id);
    CREATE INDEX transcript_draft_base ON transcript_draft (base_revision_id, content_id);

    CREATE TABLE reference_text (
      id TEXT PRIMARY KEY,
      content_id TEXT NOT NULL REFERENCES content (id) ON DELETE CASCADE,
      origin TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX reference_text_content ON reference_text (content_id);

    -- Provider profiles and platform accounts -------------------------------------------
    -- A Secret is referenced exclusively; deleting its holder deletes it.

    CREATE TABLE provider_profile (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      protocol TEXT NOT NULL,
      base_url TEXT NOT NULL,
      credential_ref TEXT UNIQUE,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (credential_ref, user_id) REFERENCES secret (id, user_id)
    ) STRICT;
    CREATE INDEX provider_profile_user ON provider_profile (user_id);

    CREATE TABLE model_capability (
      profile_id TEXT NOT NULL REFERENCES provider_profile (id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      flags_declared_json TEXT NOT NULL CHECK (json_valid(flags_declared_json)),
      flags_observed_json TEXT CHECK (flags_observed_json IS NULL OR json_valid(flags_observed_json)),
      flags_user_override_json TEXT CHECK (flags_user_override_json IS NULL OR json_valid(flags_user_override_json)),
      limits_declared_json TEXT NOT NULL CHECK (json_valid(limits_declared_json)),
      limits_observed_json TEXT CHECK (limits_observed_json IS NULL OR json_valid(limits_observed_json)),
      limits_user_override_json TEXT CHECK (limits_user_override_json IS NULL OR json_valid(limits_user_override_json)),
      observed_at INTEGER,
      PRIMARY KEY (profile_id, model_id)
    ) STRICT;

    CREATE TABLE asr_provider_profile (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES user (id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      credential_ref TEXT UNIQUE,
      base_url TEXT,
      provider_config_json TEXT CHECK (provider_config_json IS NULL OR json_valid(provider_config_json)),
      FOREIGN KEY (credential_ref, user_id) REFERENCES secret (id, user_id)
    ) STRICT;

    CREATE TABLE platform_account (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      credential_ref TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      checked_at INTEGER,
      UNIQUE (user_id, platform),
      FOREIGN KEY (credential_ref, user_id) REFERENCES secret (id, user_id)
    ) STRICT;

    CREATE TRIGGER provider_profile_secret_delete AFTER DELETE ON provider_profile
    WHEN old.credential_ref IS NOT NULL
    BEGIN
      DELETE FROM secret WHERE id = old.credential_ref;
    END;
    CREATE TRIGGER asr_provider_profile_secret_delete AFTER DELETE ON asr_provider_profile
    WHEN old.credential_ref IS NOT NULL
    BEGIN
      DELETE FROM secret WHERE id = old.credential_ref;
    END;
    CREATE TRIGGER platform_account_secret_delete AFTER DELETE ON platform_account
    BEGIN
      DELETE FROM secret WHERE id = old.credential_ref;
    END;

    -- Terminology -----------------------------------------------------------------------

    CREATE TABLE terminology_set (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
      scope_kind TEXT NOT NULL,
      collection_id TEXT,
      content_id TEXT,
      CHECK (
        (scope_kind = 'global' AND collection_id IS NULL AND content_id IS NULL)
        OR (scope_kind = 'collection' AND collection_id IS NOT NULL AND content_id IS NULL)
        OR (scope_kind = 'content' AND content_id IS NOT NULL AND collection_id IS NULL)
      ),
      FOREIGN KEY (collection_id, user_id) REFERENCES collection (id, user_id) ON DELETE CASCADE,
      FOREIGN KEY (content_id, user_id) REFERENCES content (id, user_id) ON DELETE CASCADE
    ) STRICT;
    CREATE UNIQUE INDEX terminology_set_scope
      ON terminology_set (user_id, scope_kind, coalesce(collection_id, ''), coalesce(content_id, ''));
    CREATE INDEX terminology_set_collection ON terminology_set (collection_id, user_id);
    CREATE INDEX terminology_set_content ON terminology_set (content_id, user_id);

    CREATE TABLE terminology_entry (
      id TEXT PRIMARY KEY,
      set_id TEXT NOT NULL REFERENCES terminology_set (id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      term TEXT NOT NULL,
      normalized_key TEXT NOT NULL,
      translation TEXT,
      rule TEXT
    ) STRICT;
    CREATE INDEX terminology_entry_set ON terminology_entry (set_id, ordinal);

    -- Derived artifacts -----------------------------------------------------------------
    -- Revisions share the Provenance columns: inputs_json, model_ref_json, prompt_ref_json,
    -- prompt_snapshot and created_at.

    CREATE TABLE summary_template (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES user (id) ON DELETE CASCADE,
      builtin INTEGER NOT NULL CHECK (builtin IN (0, 1)),
      name TEXT NOT NULL,
      current_version INTEGER NOT NULL CHECK (current_version >= 1),
      deleted_at INTEGER,
      -- Builtin templates are the only owner-less rows; they cannot be soft-deleted.
      CHECK ((builtin = 1) = (user_id IS NULL)),
      CHECK (builtin = 0 OR deleted_at IS NULL)
    ) STRICT;
    CREATE INDEX summary_template_user ON summary_template (user_id);

    CREATE TABLE summary_template_version (
      template_id TEXT NOT NULL REFERENCES summary_template (id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK (version >= 1),
      prompt TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (template_id, version)
    ) STRICT;

    CREATE TABLE summary_artifact (
      id TEXT PRIMARY KEY,
      content_id TEXT NOT NULL REFERENCES content (id) ON DELETE CASCADE,
      template_id TEXT NOT NULL REFERENCES summary_template (id),
      current_revision_id TEXT,
      UNIQUE (content_id, template_id),
      FOREIGN KEY (current_revision_id, id) REFERENCES summary_revision (id, artifact_id)
    ) STRICT;
    CREATE INDEX summary_artifact_template ON summary_artifact (template_id);
    CREATE INDEX summary_artifact_current ON summary_artifact (current_revision_id, id);

    CREATE TABLE summary_revision (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL REFERENCES summary_artifact (id) ON DELETE CASCADE,
      inputs_json TEXT NOT NULL CHECK (json_valid(inputs_json)),
      model_ref_json TEXT CHECK (model_ref_json IS NULL OR json_valid(model_ref_json)),
      prompt_ref_json TEXT CHECK (prompt_ref_json IS NULL OR json_valid(prompt_ref_json)),
      prompt_snapshot TEXT,
      quality TEXT NOT NULL,
      body TEXT NOT NULL,
      citations_json TEXT NOT NULL CHECK (json_valid(citations_json)),
      chapter_revision_id TEXT REFERENCES chapter_revision (id),
      partial_ids_json TEXT CHECK (partial_ids_json IS NULL OR json_valid(partial_ids_json)),
      created_at INTEGER NOT NULL,
      UNIQUE (id, artifact_id)
    ) STRICT;
    CREATE INDEX summary_revision_artifact ON summary_revision (artifact_id, created_at);
    CREATE INDEX summary_revision_chapter ON summary_revision (chapter_revision_id);

    CREATE TABLE chapter_artifact (
      id TEXT PRIMARY KEY,
      content_id TEXT NOT NULL UNIQUE REFERENCES content (id) ON DELETE CASCADE,
      current_revision_id TEXT,
      FOREIGN KEY (current_revision_id, id) REFERENCES chapter_revision (id, artifact_id)
    ) STRICT;
    CREATE INDEX chapter_artifact_current ON chapter_artifact (current_revision_id, id);

    CREATE TABLE chapter_revision (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL REFERENCES chapter_artifact (id) ON DELETE CASCADE,
      inputs_json TEXT NOT NULL CHECK (json_valid(inputs_json)),
      model_ref_json TEXT CHECK (model_ref_json IS NULL OR json_valid(model_ref_json)),
      prompt_ref_json TEXT CHECK (prompt_ref_json IS NULL OR json_valid(prompt_ref_json)),
      prompt_snapshot TEXT,
      quality TEXT NOT NULL,
      origin_json TEXT NOT NULL CHECK (json_valid(origin_json)),
      chapters_json TEXT NOT NULL CHECK (json_valid(chapters_json)),
      created_at INTEGER NOT NULL,
      UNIQUE (id, artifact_id)
    ) STRICT;
    CREATE INDEX chapter_revision_artifact ON chapter_revision (artifact_id, created_at);

    CREATE TABLE highlight_artifact (
      id TEXT PRIMARY KEY,
      content_id TEXT NOT NULL UNIQUE REFERENCES content (id) ON DELETE CASCADE,
      current_revision_id TEXT,
      FOREIGN KEY (current_revision_id, id) REFERENCES highlight_revision (id, artifact_id)
    ) STRICT;
    CREATE INDEX highlight_artifact_current ON highlight_artifact (current_revision_id, id);

    CREATE TABLE highlight_revision (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL REFERENCES highlight_artifact (id) ON DELETE CASCADE,
      inputs_json TEXT NOT NULL CHECK (json_valid(inputs_json)),
      model_ref_json TEXT CHECK (model_ref_json IS NULL OR json_valid(model_ref_json)),
      prompt_ref_json TEXT CHECK (prompt_ref_json IS NULL OR json_valid(prompt_ref_json)),
      prompt_snapshot TEXT,
      quality TEXT NOT NULL,
      transcript_revision_id TEXT NOT NULL REFERENCES transcript_revision (id),
      items_json TEXT NOT NULL CHECK (json_valid(items_json)),
      created_at INTEGER NOT NULL,
      UNIQUE (id, artifact_id)
    ) STRICT;
    CREATE INDEX highlight_revision_artifact ON highlight_revision (artifact_id, created_at);
    CREATE INDEX highlight_revision_transcript ON highlight_revision (transcript_revision_id);

    -- Translation points straight at a translated TranscriptRevision of the same Content.
    CREATE TABLE translation_artifact (
      id TEXT PRIMARY KEY,
      content_id TEXT NOT NULL REFERENCES content (id) ON DELETE CASCADE,
      target_language TEXT NOT NULL,
      current_revision_id TEXT,
      UNIQUE (content_id, target_language),
      FOREIGN KEY (current_revision_id, content_id) REFERENCES transcript_revision (id, content_id)
    ) STRICT;
    CREATE INDEX translation_artifact_current ON translation_artifact (current_revision_id, content_id);

    CREATE TABLE collection_summary_artifact (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL UNIQUE REFERENCES collection (id) ON DELETE CASCADE,
      current_revision_id TEXT,
      FOREIGN KEY (current_revision_id, id) REFERENCES collection_summary_revision (id, artifact_id)
    ) STRICT;
    CREATE INDEX collection_summary_artifact_current ON collection_summary_artifact (current_revision_id, id);

    CREATE TABLE collection_summary_revision (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL REFERENCES collection_summary_artifact (id) ON DELETE CASCADE,
      inputs_json TEXT NOT NULL CHECK (json_valid(inputs_json)),
      model_ref_json TEXT CHECK (model_ref_json IS NULL OR json_valid(model_ref_json)),
      prompt_ref_json TEXT CHECK (prompt_ref_json IS NULL OR json_valid(prompt_ref_json)),
      prompt_snapshot TEXT,
      quality TEXT NOT NULL,
      input_items_json TEXT NOT NULL CHECK (json_valid(input_items_json)),
      partial_ids_json TEXT NOT NULL CHECK (json_valid(partial_ids_json)),
      body TEXT NOT NULL,
      citations_json TEXT NOT NULL CHECK (json_valid(citations_json)),
      created_at INTEGER NOT NULL,
      UNIQUE (id, artifact_id)
    ) STRICT;
    CREATE INDEX collection_summary_revision_artifact ON collection_summary_revision (artifact_id, created_at);

    -- Rolling-summary partials, owned by exactly one SummaryRevision or CollectionSummaryRevision.
    CREATE TABLE rollup_partial (
      id TEXT PRIMARY KEY,
      summary_revision_id TEXT REFERENCES summary_revision (id) ON DELETE CASCADE,
      collection_summary_revision_id TEXT REFERENCES collection_summary_revision (id) ON DELETE CASCADE,
      partial_index INTEGER NOT NULL CHECK (partial_index >= 0),
      inputs_json TEXT NOT NULL CHECK (json_valid(inputs_json)),
      body TEXT NOT NULL,
      citations_json TEXT NOT NULL CHECK (json_valid(citations_json)),
      model_ref_json TEXT NOT NULL CHECK (json_valid(model_ref_json)),
      prompt_ref_json TEXT NOT NULL CHECK (json_valid(prompt_ref_json)),
      prompt_snapshot TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      CHECK ((summary_revision_id IS NULL) <> (collection_summary_revision_id IS NULL))
    ) STRICT;
    CREATE UNIQUE INDEX rollup_partial_summary
      ON rollup_partial (summary_revision_id, partial_index) WHERE summary_revision_id IS NOT NULL;
    CREATE UNIQUE INDEX rollup_partial_collection_summary
      ON rollup_partial (collection_summary_revision_id, partial_index) WHERE collection_summary_revision_id IS NOT NULL;

    -- Chat ------------------------------------------------------------------------------

    CREATE TABLE chat_thread (
      id TEXT PRIMARY KEY,
      content_id TEXT NOT NULL UNIQUE REFERENCES content (id) ON DELETE CASCADE,
      current_compaction_id TEXT,
      FOREIGN KEY (current_compaction_id, id) REFERENCES chat_compaction (id, thread_id)
    ) STRICT;
    CREATE INDEX chat_thread_current_compaction ON chat_thread (current_compaction_id, id);

    CREATE TABLE chat_message (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES chat_thread (id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      model_ref_json TEXT CHECK (model_ref_json IS NULL OR json_valid(model_ref_json)),
      context_transcript_revision_id TEXT REFERENCES transcript_revision (id),
      citations_json TEXT NOT NULL CHECK (json_valid(citations_json)),
      suggestions_json TEXT CHECK (suggestions_json IS NULL OR json_valid(suggestions_json)),
      created_at INTEGER NOT NULL,
      UNIQUE (id, thread_id)
    ) STRICT;
    CREATE INDEX chat_message_thread ON chat_message (thread_id, created_at);
    CREATE INDEX chat_message_context ON chat_message (context_transcript_revision_id);

    CREATE TABLE chat_compaction (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES chat_thread (id) ON DELETE CASCADE,
      through_message_id TEXT NOT NULL,
      body TEXT NOT NULL,
      model_ref_json TEXT NOT NULL CHECK (json_valid(model_ref_json)),
      prompt_ref_json TEXT NOT NULL CHECK (json_valid(prompt_ref_json)),
      prompt_snapshot TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (id, thread_id),
      FOREIGN KEY (through_message_id, thread_id) REFERENCES chat_message (id, thread_id)
    ) STRICT;
    CREATE INDEX chat_compaction_thread ON chat_compaction (thread_id, created_at);
    CREATE INDEX chat_compaction_through ON chat_compaction (through_message_id, thread_id);

    -- Usage: kept when its Content / Collection / Profile goes, with links cleared --------

    CREATE TABLE token_usage (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
      model_ref_json TEXT NOT NULL CHECK (json_valid(model_ref_json)),
      feature TEXT NOT NULL,
      task_id TEXT REFERENCES task (id) ON DELETE SET NULL,
      work_unit_id TEXT REFERENCES work_unit (id) ON DELETE SET NULL,
      -- Polymorphic (any revision table), hence cleared by the triggers below instead of a key.
      artifact_revision_id TEXT,
      chat_message_id TEXT REFERENCES chat_message (id) ON DELETE SET NULL,
      content_id TEXT REFERENCES content (id) ON DELETE SET NULL,
      outcome TEXT NOT NULL,
      input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
      output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
      cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
      cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
      reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
      raw_usage_json TEXT CHECK (raw_usage_json IS NULL OR json_valid(raw_usage_json)),
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX token_usage_user_created ON token_usage (user_id, created_at);
    CREATE INDEX token_usage_task ON token_usage (task_id);
    CREATE INDEX token_usage_work_unit ON token_usage (work_unit_id);
    CREATE INDEX token_usage_artifact_revision ON token_usage (artifact_revision_id);
    CREATE INDEX token_usage_chat_message ON token_usage (chat_message_id);
    CREATE INDEX token_usage_content ON token_usage (content_id);

    CREATE TABLE asr_usage (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
      asr_profile_id TEXT REFERENCES asr_provider_profile (id) ON DELETE SET NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      outcome TEXT NOT NULL,
      audio_ms INTEGER NOT NULL CHECK (audio_ms >= 0),
      task_id TEXT REFERENCES task (id) ON DELETE SET NULL,
      content_id TEXT REFERENCES content (id) ON DELETE SET NULL,
      raw_usage_json TEXT CHECK (raw_usage_json IS NULL OR json_valid(raw_usage_json)),
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX asr_usage_user_created ON asr_usage (user_id, created_at);
    CREATE INDEX asr_usage_profile ON asr_usage (asr_profile_id);
    CREATE INDEX asr_usage_task ON asr_usage (task_id);
    CREATE INDEX asr_usage_content ON asr_usage (content_id);

    CREATE TRIGGER transcript_revision_usage_unlink AFTER DELETE ON transcript_revision
    BEGIN
      UPDATE token_usage SET artifact_revision_id = NULL WHERE artifact_revision_id = old.id;
    END;
    CREATE TRIGGER summary_revision_usage_unlink AFTER DELETE ON summary_revision
    BEGIN
      UPDATE token_usage SET artifact_revision_id = NULL WHERE artifact_revision_id = old.id;
    END;
    CREATE TRIGGER chapter_revision_usage_unlink AFTER DELETE ON chapter_revision
    BEGIN
      UPDATE token_usage SET artifact_revision_id = NULL WHERE artifact_revision_id = old.id;
    END;
    CREATE TRIGGER highlight_revision_usage_unlink AFTER DELETE ON highlight_revision
    BEGIN
      UPDATE token_usage SET artifact_revision_id = NULL WHERE artifact_revision_id = old.id;
    END;
    CREATE TRIGGER collection_summary_revision_usage_unlink AFTER DELETE ON collection_summary_revision
    BEGIN
      UPDATE token_usage SET artifact_revision_id = NULL WHERE artifact_revision_id = old.id;
    END;
    CREATE TRIGGER rollup_partial_usage_unlink AFTER DELETE ON rollup_partial
    BEGIN
      UPDATE token_usage SET artifact_revision_id = NULL WHERE artifact_revision_id = old.id;
    END;
    CREATE TRIGGER chat_compaction_usage_unlink AFTER DELETE ON chat_compaction
    BEGIN
      UPDATE token_usage SET artifact_revision_id = NULL WHERE artifact_revision_id = old.id;
    END;

    -- Invariant: committed rows are immutable -----------------------------------------

    CREATE TRIGGER transcript_revision_immutable BEFORE UPDATE ON transcript_revision
    BEGIN
      SELECT RAISE(ABORT, 'transcript_revision is immutable');
    END;
    CREATE TRIGGER transcript_segment_immutable BEFORE UPDATE ON transcript_segment
    BEGIN
      SELECT RAISE(ABORT, 'transcript_segment is immutable');
    END;
    CREATE TRIGGER transcript_segment_source_immutable BEFORE UPDATE ON transcript_segment_source
    BEGIN
      SELECT RAISE(ABORT, 'transcript_segment_source is immutable');
    END;
    CREATE TRIGGER summary_template_version_immutable BEFORE UPDATE ON summary_template_version
    BEGIN
      SELECT RAISE(ABORT, 'summary_template_version is immutable');
    END;
    CREATE TRIGGER summary_revision_immutable BEFORE UPDATE ON summary_revision
    BEGIN
      SELECT RAISE(ABORT, 'summary_revision is immutable');
    END;
    CREATE TRIGGER chapter_revision_immutable BEFORE UPDATE ON chapter_revision
    BEGIN
      SELECT RAISE(ABORT, 'chapter_revision is immutable');
    END;
    CREATE TRIGGER highlight_revision_immutable BEFORE UPDATE ON highlight_revision
    BEGIN
      SELECT RAISE(ABORT, 'highlight_revision is immutable');
    END;
    CREATE TRIGGER collection_summary_revision_immutable BEFORE UPDATE ON collection_summary_revision
    BEGIN
      SELECT RAISE(ABORT, 'collection_summary_revision is immutable');
    END;
    CREATE TRIGGER rollup_partial_immutable BEFORE UPDATE ON rollup_partial
    BEGIN
      SELECT RAISE(ABORT, 'rollup_partial is immutable');
    END;
    CREATE TRIGGER chat_compaction_immutable BEFORE UPDATE ON chat_compaction
    BEGIN
      SELECT RAISE(ABORT, 'chat_compaction is immutable');
    END;
  `,
};
