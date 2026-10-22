import type { Task } from "../../../domain/task.ts";
import type { TaskRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { notFound, nullable, withoutNulls } from "./rows.ts";

interface TaskRow {
  id: string;
  user_id: string;
  content_id: string | null;
  collection_id: string | null;
  kind: Task["kind"];
  request_json: string;
  status_projection: Task["statusProjection"];
  created_at: number;
  finished_at: number | null;
}

function toTask(row: TaskRow): Task {
  return withoutNulls<Task>({
    id: row.id,
    userId: row.user_id,
    contentId: row.content_id,
    collectionId: row.collection_id,
    kind: row.kind,
    requestJson: row.request_json,
    statusProjection: row.status_projection,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  });
}

export function sqliteTaskRepository(db: SqliteConnection): TaskRepository {
  const select = db.prepare("SELECT * FROM task WHERE id = ? AND user_id = ?");
  // Optional filters are NULL when unused, so one statement serves every combination.
  const page = db.prepare(
    `SELECT * FROM task
     WHERE user_id = @owner
       AND (@unfinished = 0 OR finished_at IS NULL)
       AND (@finished = 0 OR finished_at IS NOT NULL)
       AND (@contentId IS NULL OR content_id = @contentId)
       AND (@collectionId IS NULL OR collection_id = @collectionId)
       AND (@kind IS NULL OR kind = @kind)
       AND (@createdAt IS NULL OR created_at < @createdAt OR (created_at = @createdAt AND id < @id))
       AND NOT EXISTS (SELECT 1 FROM content WHERE content.id = task.content_id AND content.trashed_at IS NOT NULL)
     ORDER BY created_at DESC, id DESC LIMIT @limit`,
  );
  const byContent = db.prepare("SELECT * FROM task WHERE content_id = ? AND user_id = ? ORDER BY created_at, id");
  const byCollection = db.prepare("SELECT * FROM task WHERE collection_id = ? AND user_id = ? ORDER BY created_at, id");
  const unfinished = db.prepare("SELECT * FROM task WHERE finished_at IS NULL ORDER BY created_at, id");
  const unfinishedOf = db.prepare("SELECT * FROM task WHERE user_id = ? AND finished_at IS NULL ORDER BY created_at, id");
  const unscoped = db.prepare("SELECT * FROM task WHERE id = ?");
  const insert = db.prepare(
    `INSERT INTO task (id, user_id, content_id, collection_id, kind, request_json, status_projection, created_at, finished_at)
     VALUES (@id, @userId, @contentId, @collectionId, @kind, @requestJson, @statusProjection, @createdAt, @finishedAt)`,
  );
  const setProjection = db.prepare("UPDATE task SET status_projection = ?, finished_at = ? WHERE id = ? AND user_id = ?");

  return {
    get(ownerUserId, taskId) {
      const row = select.get(taskId, ownerUserId) as TaskRow | undefined;
      return row === undefined ? undefined : toTask(row);
    },
    list(ownerUserId, { limit, after, unfinished, finished, contentId, collectionId, kind }) {
      const rows = page.all({
        owner: ownerUserId,
        unfinished: unfinished === true ? 1 : 0,
        finished: finished === true ? 1 : 0,
        contentId: contentId ?? null,
        collectionId: collectionId ?? null,
        kind: kind ?? null,
        createdAt: after?.createdAt ?? null,
        id: after?.id ?? null,
        limit,
      });
      return (rows as TaskRow[]).map(toTask);
    },
    listByContent(ownerUserId, contentId) {
      return (byContent.all(contentId, ownerUserId) as TaskRow[]).map(toTask);
    },
    listByCollection(ownerUserId, collectionId) {
      return (byCollection.all(collectionId, ownerUserId) as TaskRow[]).map(toTask);
    },
    listUnfinished() {
      return (unfinished.all() as TaskRow[]).map(toTask);
    },
    listUnfinishedOf(ownerUserId) {
      return (unfinishedOf.all(ownerUserId) as TaskRow[]).map(toTask);
    },
    getUnscoped(taskId) {
      const row = unscoped.get(taskId) as TaskRow | undefined;
      return row === undefined ? undefined : toTask(row);
    },
    insert(task) {
      insert.run({
        id: task.id,
        userId: task.userId,
        contentId: nullable(task.contentId),
        collectionId: nullable(task.collectionId),
        kind: task.kind,
        requestJson: task.requestJson,
        statusProjection: task.statusProjection,
        createdAt: task.createdAt,
        finishedAt: nullable(task.finishedAt),
      });
    },
    setProjection(ownerUserId, taskId, status, finishedAt) {
      if (setProjection.run(status, nullable(finishedAt), taskId, ownerUserId).changes === 0) {
        throw notFound("task", taskId);
      }
    },
  };
}
