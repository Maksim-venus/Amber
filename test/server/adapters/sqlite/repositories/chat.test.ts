import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import type { ChatMessage } from "../../../../../src/server/domain/chat.ts";
import type { SegmentId } from "../../../../../src/shared/ids.ts";
import { countRows, insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
const SEG = "01J00000000000000000000001" as SegmentId;
const snapshot = { providerProfileId: "p", modelId: "m", providerNameSnapshot: "P", modelDisplaySnapshot: "m" };
let db: SqliteConnection;
let repository: SqliteRepository;

function message(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id, threadId: "t", role: "user", text: `text ${id}`, status: "complete", citations: [], createdAt: T0, ...overrides };
}

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
  insertRow(db, "content", { id: "c", user_id: "alice", source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
  repository.withTransaction((scope) => scope.chat.insertThread("alice", { id: "t", contentId: "c" }));
});

describe("chat repository", () => {
  it("stores one thread per Content and messages in order, with JSON fields round-tripped", () => {
    repository.withTransaction((scope) => {
      scope.chat.insertMessage("alice", message("m2", { role: "assistant", status: "streaming", modelRef: snapshot, createdAt: T0 + 1 }));
      scope.chat.insertMessage("alice", message("m1", { citations: [{ transcriptRevisionId: "r", segmentId: SEG }] }));
    });
    const thread = repository.withTransaction((scope) => scope.chat.getThread("alice", "c"));
    expect(thread).toEqual({ id: "t", contentId: "c" });
    const messages = repository.withTransaction((scope) => scope.chat.listMessages("alice", "t"));
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(messages[0]?.citations).toEqual([{ transcriptRevisionId: "r", segmentId: SEG }]);
    expect(messages[1]).toMatchObject({ role: "assistant", status: "streaming", modelRef: snapshot });
    expect(messages[1]?.suggestions).toBeUndefined();
    expect(() => repository.withTransaction((scope) => scope.chat.insertThread("alice", { id: "t2", contentId: "c" }))).toThrow(/UNIQUE/);
  });

  it("writes the final state of an answer", () => {
    repository.withTransaction((scope) => scope.chat.insertMessage("alice", message("a", { role: "assistant", status: "streaming", text: "" })));
    repository.withTransaction((scope) =>
      scope.chat.finishMessage("alice", { id: "a", text: `done [[seg:${SEG}]]`, status: "complete", citations: [{ transcriptRevisionId: "r", segmentId: SEG }], suggestions: ["next?"] }),
    );
    expect(repository.withTransaction((scope) => scope.chat.getMessage("alice", "a"))).toMatchObject({
      text: `done [[seg:${SEG}]]`,
      status: "complete",
      suggestions: ["next?"],
    });
  });

  it("makes a new compaction the thread's current one", () => {
    repository.withTransaction((scope) => {
      scope.chat.insertMessage("alice", message("m1"));
      scope.chat.insertCompaction("alice", {
        id: "k",
        threadId: "t",
        throughMessageId: "m1",
        body: "summary",
        modelRef: snapshot,
        promptRef: { id: "chat.compaction", version: 1 },
        promptSnapshot: "prompt",
        createdAt: T0,
      });
    });
    expect(repository.withTransaction((scope) => scope.chat.getThread("alice", "c"))?.currentCompactionId).toBe("k");
    expect(repository.withTransaction((scope) => scope.chat.getCompaction("alice", "k"))).toMatchObject({ body: "summary", throughMessageId: "m1" });
  });

  it("hides another owner's chat and refuses writes into it", () => {
    repository.withTransaction((scope) => scope.chat.insertMessage("alice", message("m1")));
    expect(repository.withTransaction((scope) => scope.chat.getThread("bob", "c"))).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.chat.listMessages("bob", "t"))).toEqual([]);
    expect(repository.withTransaction((scope) => scope.chat.getMessage("bob", "m1"))).toBeUndefined();
    expect(() => repository.withTransaction((scope) => scope.chat.insertMessage("bob", message("m9")))).toThrow(/not found/);
    expect(() => repository.withTransaction((scope) => scope.chat.insertThread("bob", { id: "x", contentId: "c" }))).toThrow(/not found/);
    expect(repository.withTransaction((scope) => scope.chat.deleteThread("bob", "c"))).toBe(false);
  });

  it("deletes the whole thread, compactions included, and keeps usage rows unlinked", () => {
    repository.withTransaction((scope) => {
      scope.chat.insertMessage("alice", message("m1"));
      scope.chat.insertMessage("alice", message("a1", { role: "assistant", createdAt: T0 + 1 }));
      scope.chat.insertCompaction("alice", {
        id: "k", threadId: "t", throughMessageId: "a1", body: "s", modelRef: snapshot, promptRef: { id: "chat.compaction", version: 1 }, promptSnapshot: "p", createdAt: T0,
      });
      scope.tokenUsage.insert({ id: "u", userId: "alice", modelRef: snapshot, feature: "chat", chatMessageId: "a1", contentId: "c", outcome: "succeeded", createdAt: T0 });
    });
    expect(repository.withTransaction((scope) => scope.chat.deleteThread("alice", "c"))).toBe(true);
    expect(countRows(db, "chat_thread")).toBe(0);
    expect(countRows(db, "chat_message")).toBe(0);
    expect(countRows(db, "chat_compaction")).toBe(0);
    expect(repository.withTransaction((scope) => scope.tokenUsage.list("alice"))[0]?.chatMessageId).toBeUndefined();
  });

  it("turns answers left streaming into interrupted ones", () => {
    repository.withTransaction((scope) => {
      scope.chat.insertMessage("alice", message("a1", { role: "assistant", status: "streaming" }));
      scope.chat.insertMessage("alice", message("a2", { role: "assistant", status: "complete", createdAt: T0 + 1 }));
    });
    expect(repository.withTransaction((scope) => scope.chat.interruptStreaming())).toBe(1);
    expect(repository.withTransaction((scope) => scope.chat.getMessage("alice", "a1"))?.status).toBe("interrupted");
  });
});
