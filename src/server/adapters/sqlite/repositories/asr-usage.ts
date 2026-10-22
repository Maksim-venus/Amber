import type { AsrUsage } from "../../../domain/usage.ts";
import type { AsrUsageRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { notFound, nullable, withoutNulls } from "./rows.ts";

interface AsrUsageRow {
  id: string;
  user_id: string;
  asr_profile_id: string | null;
  provider: string;
  model: string;
  feature: AsrUsage["feature"];
  outcome: AsrUsage["outcome"];
  audio_ms: number;
  task_id: string | null;
  content_id: string | null;
  raw_usage_json: string | null;
  created_at: number;
}

function toUsage(row: AsrUsageRow): AsrUsage {
  return withoutNulls<AsrUsage>({
    id: row.id,
    userId: row.user_id,
    asrProfileId: row.asr_profile_id,
    provider: row.provider,
    model: row.model,
    feature: row.feature,
    outcome: row.outcome,
    audioMs: row.audio_ms,
    taskId: row.task_id,
    contentId: row.content_id,
    rawUsageJson: row.raw_usage_json,
    createdAt: row.created_at,
  });
}

/** Usage rows reference only the inserting user's own profile, Task and Content. */
export function sqliteAsrUsageRepository(db: SqliteConnection): AsrUsageRepository {
  const insert = db.prepare(
    `INSERT INTO asr_usage (id, user_id, asr_profile_id, provider, model, feature, outcome, audio_ms, task_id, content_id, raw_usage_json, created_at)
     VALUES (@id, @userId, @asrProfileId, @provider, @model, @feature, @outcome, @audioMs, @taskId, @contentId, @rawUsageJson, @createdAt)`,
  );
  const list = db.prepare(
    `SELECT * FROM asr_usage
     WHERE user_id = @userId
       AND (@taskId IS NULL OR task_id = @taskId)
       AND (@contentId IS NULL OR content_id = @contentId)
       AND (@since IS NULL OR created_at >= @since)
       AND (@until IS NULL OR created_at < @until)
     ORDER BY created_at, id`,
  );
  const owned = {
    profile: db.prepare("SELECT 1 FROM asr_provider_profile WHERE id = ? AND user_id = ?"),
    task: db.prepare("SELECT 1 FROM task WHERE id = ? AND user_id = ?"),
    content: db.prepare("SELECT 1 FROM content WHERE id = ? AND user_id = ?"),
  };
  const requireOwned = (kind: keyof typeof owned, id: string | undefined, ownerUserId: string): void => {
    if (id !== undefined && owned[kind].get(id, ownerUserId) === undefined) {
      throw notFound(kind === "profile" ? "asr profile" : kind, id);
    }
  };

  return {
    insert(usage) {
      requireOwned("profile", usage.asrProfileId, usage.userId);
      requireOwned("task", usage.taskId, usage.userId);
      requireOwned("content", usage.contentId, usage.userId);
      insert.run({
        id: usage.id,
        userId: usage.userId,
        asrProfileId: nullable(usage.asrProfileId),
        provider: usage.provider,
        model: usage.model,
        feature: usage.feature,
        outcome: usage.outcome,
        audioMs: usage.audioMs,
        taskId: nullable(usage.taskId),
        contentId: nullable(usage.contentId),
        rawUsageJson: nullable(usage.rawUsageJson),
        createdAt: usage.createdAt,
      });
    },
    list(ownerUserId, query = {}) {
      const rows = list.all({
        userId: ownerUserId,
        taskId: nullable(query.taskId),
        contentId: nullable(query.contentId),
        since: nullable(query.since),
        until: nullable(query.until),
      }) as AsrUsageRow[];
      return rows.map(toUsage);
    },
  };
}
