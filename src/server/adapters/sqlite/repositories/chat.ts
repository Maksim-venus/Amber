import type { Citation } from "../../../domain/artifact.ts";
import type { ChatCompaction, ChatMessage, ChatThread } from "../../../domain/chat.ts";
import type { ModelRefSnapshot, PromptRef } from "../../../domain/model-ref.ts";
import type { ChatRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { jsonOrNull, notFound, nullable, parseJson, parseJsonOrNull, withoutNulls } from "./rows.ts";

interface ThreadRow {
  id: string;
  content_id: string;
  current_compaction_id: string | null;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: ChatMessage["role"];
  text: string;
  status: ChatMessage["status"];
  model_ref_json: string | null;
  context_transcript_revision_id: string | null;
  citations_json: string;
  suggestions_json: string | null;
  created_at: number;
}

interface CompactionRow {
  id: string;
  thread_id: string;
  through_message_id: string;
  body: string;
  model_ref_json: string;
  prompt_ref_json: string;
  prompt_snapshot: string;
  created_at: number;
}

function toThread(row: ThreadRow): ChatThread {
  return withoutNulls<ChatThread>({ id: row.id, contentId: row.content_id, currentCompactionId: row.current_compaction_id });
}

function toMessage(row: MessageRow): ChatMessage {
  return withoutNulls<ChatMessage>({
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    text: row.text,
    status: row.status,
    modelRef: parseJsonOrNull<ModelRefSnapshot>(row.model_ref_json),
    contextTranscriptRevisionId: row.context_transcript_revision_id,
    citations: parseJson<Citation[]>(row.citations_json),
    suggestions: parseJsonOrNull<string[]>(row.suggestions_json),
    createdAt: row.created_at,
  });
}

function toCompaction(row: CompactionRow): ChatCompaction {
  return {
    id: row.id,
    threadId: row.thread_id,
    throughMessageId: row.through_message_id,
    body: row.body,
    modelRef: parseJson<ModelRefSnapshot>(row.model_ref_json),
    promptRef: parseJson<PromptRef>(row.prompt_ref_json),
    promptSnapshot: row.prompt_snapshot,
    createdAt: row.created_at,
  };
}

/** Invariant: ownership of chat rows goes through the thread's Content, and every lookup checks its owner. */
export function sqliteChatRepository(db: SqliteConnection): ChatRepository {
  const ownedContent = db.prepare("SELECT 1 FROM content WHERE id = ? AND user_id = ?");
  const threadByContent = db.prepare(
    `SELECT chat_thread.* FROM chat_thread JOIN content ON content.id = chat_thread.content_id
     WHERE chat_thread.content_id = ? AND content.user_id = ?`,
  );
  const ownedThread = db.prepare(
    `SELECT 1 FROM chat_thread JOIN content ON content.id = chat_thread.content_id WHERE chat_thread.id = ? AND content.user_id = ?`,
  );
  const insertThread = db.prepare("INSERT INTO chat_thread (id, content_id, current_compaction_id) VALUES (@id, @contentId, NULL)");
  const messagesOf = db.prepare(
    `SELECT chat_message.* FROM chat_message
     JOIN chat_thread ON chat_thread.id = chat_message.thread_id JOIN content ON content.id = chat_thread.content_id
     WHERE chat_message.thread_id = ? AND content.user_id = ? ORDER BY chat_message.created_at, chat_message.id`,
  );
  const messageById = db.prepare(
    `SELECT chat_message.* FROM chat_message
     JOIN chat_thread ON chat_thread.id = chat_message.thread_id JOIN content ON content.id = chat_thread.content_id
     WHERE chat_message.id = ? AND content.user_id = ?`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO chat_message (id, thread_id, role, text, status, model_ref_json, context_transcript_revision_id, citations_json, suggestions_json, created_at)
     VALUES (@id, @threadId, @role, @text, @status, @modelRef, @contextTranscriptRevisionId, @citations, @suggestions, @createdAt)`,
  );
  const finishMessage = db.prepare(
    "UPDATE chat_message SET text = @text, status = @status, citations_json = @citations, suggestions_json = @suggestions WHERE id = @id",
  );
  const compactionById = db.prepare(
    `SELECT chat_compaction.* FROM chat_compaction
     JOIN chat_thread ON chat_thread.id = chat_compaction.thread_id JOIN content ON content.id = chat_thread.content_id
     WHERE chat_compaction.id = ? AND content.user_id = ?`,
  );
  const insertCompaction = db.prepare(
    `INSERT INTO chat_compaction (id, thread_id, through_message_id, body, model_ref_json, prompt_ref_json, prompt_snapshot, created_at)
     VALUES (@id, @threadId, @throughMessageId, @body, @modelRef, @promptRef, @promptSnapshot, @createdAt)`,
  );
  const setCurrentCompaction = db.prepare("UPDATE chat_thread SET current_compaction_id = ? WHERE id = ?");
  const deleteThread = db.prepare("DELETE FROM chat_thread WHERE content_id = ? AND content_id IN (SELECT id FROM content WHERE user_id = ?)");
  const interrupt = db.prepare("UPDATE chat_message SET status = 'interrupted' WHERE status = 'streaming'");

  const requireThread = (ownerUserId: string, threadId: string): void => {
    if (ownedThread.get(threadId, ownerUserId) === undefined) {
      throw notFound("chat thread", threadId);
    }
  };

  return {
    getThread(ownerUserId, contentId) {
      const row = threadByContent.get(contentId, ownerUserId) as ThreadRow | undefined;
      return row === undefined ? undefined : toThread(row);
    },
    insertThread(ownerUserId, thread) {
      if (ownedContent.get(thread.contentId, ownerUserId) === undefined) {
        throw notFound("content", thread.contentId);
      }
      insertThread.run({ id: thread.id, contentId: thread.contentId });
    },
    listMessages(ownerUserId, threadId) {
      return (messagesOf.all(threadId, ownerUserId) as MessageRow[]).map(toMessage);
    },
    getMessage(ownerUserId, messageId) {
      const row = messageById.get(messageId, ownerUserId) as MessageRow | undefined;
      return row === undefined ? undefined : toMessage(row);
    },
    insertMessage(ownerUserId, message) {
      requireThread(ownerUserId, message.threadId);
      insertMessage.run({
        id: message.id,
        threadId: message.threadId,
        role: message.role,
        text: message.text,
        status: message.status,
        modelRef: jsonOrNull(message.modelRef),
        contextTranscriptRevisionId: nullable(message.contextTranscriptRevisionId),
        citations: JSON.stringify(message.citations),
        suggestions: jsonOrNull(message.suggestions),
        createdAt: message.createdAt,
      });
    },
    finishMessage(ownerUserId, message) {
      if (messageById.get(message.id, ownerUserId) === undefined) {
        throw notFound("chat message", message.id);
      }
      finishMessage.run({
        id: message.id,
        text: message.text,
        status: message.status,
        citations: JSON.stringify(message.citations),
        suggestions: jsonOrNull(message.suggestions),
      });
    },
    getCompaction(ownerUserId, compactionId) {
      const row = compactionById.get(compactionId, ownerUserId) as CompactionRow | undefined;
      return row === undefined ? undefined : toCompaction(row);
    },
    insertCompaction(ownerUserId, compaction) {
      requireThread(ownerUserId, compaction.threadId);
      insertCompaction.run({
        id: compaction.id,
        threadId: compaction.threadId,
        throughMessageId: compaction.throughMessageId,
        body: compaction.body,
        modelRef: JSON.stringify(compaction.modelRef),
        promptRef: JSON.stringify(compaction.promptRef),
        promptSnapshot: compaction.promptSnapshot,
        createdAt: compaction.createdAt,
      });
      setCurrentCompaction.run(compaction.id, compaction.threadId);
    },
    deleteThread(ownerUserId, contentId) {
      return deleteThread.run(contentId, ownerUserId).changes > 0;
    },
    interruptStreaming() {
      return interrupt.run().changes;
    },
  };
}
