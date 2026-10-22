import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import { isAmberError } from "../../../../../src/server/domain/errors.ts";
import { normalizeTermKey, type TerminologyEntry, type TerminologyScope, type TerminologySet } from "../../../../../src/server/domain/terminology.ts";
import { countRows, insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;

function termSet(id: string, userId: string, scope: { collection_id?: string; content_id?: string }): void {
  const scopeKind = scope.content_id !== undefined ? "content" : scope.collection_id !== undefined ? "collection" : "global";
  insertRow(db, "terminology_set", { id, user_id: userId, scope_kind: scopeKind, ...scope });
}

function term(setId: string, id: string, text: string, ordinal: number, extra: Record<string, unknown> = {}): void {
  insertRow(db, "terminology_entry", { id, set_id: setId, ordinal, term: text, normalized_key: normalizeTermKey(text), ...extra });
}

function collection(id: string, userId: string, contentId: string, addedAt: number): void {
  insertRow(db, "collection", { id, user_id: userId, name: id, created_at: T0 });
  insertRow(db, "collection_item", { id: `${id}-item`, collection_id: id, content_id: contentId, position: 0, added_at: addedAt });
}

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) {
    insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
    insertRow(db, "content", { id: `c-${id}`, user_id: id, source_kind: "local", processing_status: "queued", created_at: T0, updated_at: T0 });
  }
});

const effective = (owner: string, contentId: string) =>
  repository.withTransaction((scope) => scope.terminology.effectiveFor(owner, contentId));

describe("terminology repository", () => {
  it("merges content, every collection by the time the content joined it, then global", () => {
    // The later-created collection was joined first, so it wins over the other one.
    collection("course-b", "alice", "c-alice", T0 + 2);
    collection("course-a", "alice", "c-alice", T0 + 1);
    termSet("g", "alice", {});
    termSet("x", "alice", { content_id: "c-alice" });
    termSet("ca", "alice", { collection_id: "course-a" });
    termSet("cb", "alice", { collection_id: "course-b" });
    term("g", "g1", "LLM", 0);
    term("g", "g2", "agent", 1, { translation: "智能体" });
    term("cb", "b1", "Agent", 0, { translation: "代理" });
    term("cb", "b2", "Harness", 1);
    term("ca", "a2", "Prompt", 1);
    term("ca", "a1", "AGENT", 0, { rule: "keep_original" });
    term("x", "x1", "生成式软件工程", 0);

    expect(effective("alice", "c-alice").map((entry) => entry.id)).toEqual(["x1", "a1", "a2", "b2", "g1"]);
    expect(effective("alice", "c-alice")[1]).toEqual({ id: "a1", ordinal: 0, term: "AGENT", normalizedKey: "agent", rule: "keep_original" });
  });

  it("never mixes in another user's sets", () => {
    collection("alice-course", "alice", "c-alice", T0);
    termSet("ag", "alice", {});
    termSet("ax", "alice", { content_id: "c-alice" });
    termSet("ac", "alice", { collection_id: "alice-course" });
    term("ag", "ag1", "alice global", 0);
    term("ax", "ax1", "alice content", 0);
    term("ac", "ac1", "alice course", 0);
    termSet("bg", "bob", {});
    term("bg", "bg1", "bob global", 0);

    expect(effective("bob", "c-alice").map((entry) => entry.id)).toEqual(["bg1"]);
    expect(effective("bob", "c-bob").map((entry) => entry.id)).toEqual(["bg1"]);
  });

  it("is empty without any set", () => {
    expect(effective("alice", "c-alice")).toEqual([]);
  });
});

describe("collection terminology", () => {
  const forCollection = (owner: string, collectionId: string) =>
    repository.withTransaction((scope) => scope.terminology.effectiveForCollection(owner, collectionId));

  it("merges the collection's set before global, collection winning", () => {
    collection("course", "alice", "c-alice", T0);
    termSet("g", "alice", {});
    termSet("cs", "alice", { collection_id: "course" });
    termSet("x", "alice", { content_id: "c-alice" });
    term("g", "g1", "agent", 0, { translation: "智能体" });
    term("g", "g2", "LLM", 1);
    term("cs", "c1", "Agent", 0, { translation: "代理" });
    term("x", "x1", "member only", 0);
    expect(forCollection("alice", "course").map((entry) => entry.id)).toEqual(["c1", "g2"]);
  });

  it("ignores another user's collection and falls back to the owner's global set", () => {
    collection("course", "alice", "c-alice", T0);
    termSet("cs", "alice", { collection_id: "course" });
    term("cs", "c1", "Agent", 0);
    termSet("bg", "bob", {});
    term("bg", "bg1", "bob global", 0);
    expect(forCollection("bob", "course").map((entry) => entry.id)).toEqual(["bg1"]);
    expect(forCollection("alice", "missing")).toEqual([]);
  });
});

describe("terminology writes", () => {
  const entry = (id: string, text: string, ordinal: number, extra: Partial<TerminologyEntry> = {}): TerminologyEntry => ({
    id, ordinal, term: text, normalizedKey: normalizeTermKey(text), ...extra,
  });
  const set = (id: string, userId: string, scope: TerminologyScope, entries: TerminologyEntry[]): TerminologySet => ({ id, userId, scope, entries });
  const put = (value: TerminologySet) => repository.withTransaction((scope) => scope.terminology.put(value));
  const get = (owner: string, scope: TerminologyScope) => repository.withTransaction((s) => s.terminology.get(owner, scope));
  const code = (work: () => unknown): string | undefined => {
    try {
      work();
    } catch (error) {
      return isAmberError(error) ? error.appError.code : String(error);
    }
    return undefined;
  };

  it("creates a set per scope and reads it back in ordinal order", () => {
    collection("course", "alice", "c-alice", T0);
    put(set("g", "alice", { kind: "global" }, [entry("g2", "Agent", 1, { translation: "智能体" }), entry("g1", "LLM", 0, { rule: "keep_original" })]));
    put(set("k", "alice", { kind: "collection", collectionId: "course" }, [entry("k1", "Harness", 0)]));
    put(set("x", "alice", { kind: "content", contentId: "c-alice" }, [entry("x1", "RAG", 0)]));
    expect(get("alice", { kind: "global" })).toEqual(
      set("g", "alice", { kind: "global" }, [entry("g1", "LLM", 0, { rule: "keep_original" }), entry("g2", "Agent", 1, { translation: "智能体" })]),
    );
    expect(get("alice", { kind: "collection", collectionId: "course" })?.entries.map((e) => e.id)).toEqual(["k1"]);
    expect(get("alice", { kind: "content", contentId: "c-alice" })?.entries.map((e) => e.id)).toEqual(["x1"]);
    expect(get("bob", { kind: "global" })).toBeUndefined();
    expect(get("alice", { kind: "content", contentId: "c-bob" })).toBeUndefined();
  });

  it("replaces the whole set under its existing id and removes a set left empty", () => {
    put(set("g", "alice", { kind: "global" }, [entry("g1", "LLM", 0), entry("g2", "Agent", 1)]));
    put(set("ignored", "alice", { kind: "global" }, [entry("g3", "Prompt", 0)]));
    expect(get("alice", { kind: "global" })).toEqual(set("g", "alice", { kind: "global" }, [entry("g3", "Prompt", 0)]));
    expect(countRows(db, "terminology_entry")).toBe(1);
    put(set("ignored", "alice", { kind: "global" }, []));
    expect(get("alice", { kind: "global" })).toBeUndefined();
    expect(countRows(db, "terminology_set")).toBe(0);
    expect(countRows(db, "terminology_entry")).toBe(0);
    // Emptying a scope that has no set is a no-op.
    put(set("none", "alice", { kind: "global" }, []));
    expect(countRows(db, "terminology_set")).toBe(0);
  });

  it("refuses a collection or content scope the owner does not have", () => {
    collection("bobs-course", "bob", "c-bob", T0);
    expect(code(() => put(set("s", "alice", { kind: "collection", collectionId: "bobs-course" }, [entry("e", "x", 0)])))).toBe("not_found");
    expect(code(() => put(set("s", "alice", { kind: "content", contentId: "c-bob" }, [entry("e", "x", 0)])))).toBe("not_found");
    expect(code(() => put(set("s", "alice", { kind: "content", contentId: "missing" }, [])))).toBe("not_found");
    expect(countRows(db, "terminology_set")).toBe(0);
  });

  it("keeps sets of different scopes and owners apart", () => {
    put(set("ga", "alice", { kind: "global" }, [entry("a1", "LLM", 0)]));
    put(set("gb", "bob", { kind: "global" }, [entry("b1", "LLM", 0)]));
    put(set("ga", "alice", { kind: "global" }, []));
    expect(get("bob", { kind: "global" })?.entries.map((e) => e.id)).toEqual(["b1"]);
  });

  it("feeds effectiveFor: content beats collections in join order beats global", () => {
    collection("course-b", "alice", "c-alice", T0 + 2);
    collection("course-a", "alice", "c-alice", T0 + 1);
    put(set("g", "alice", { kind: "global" }, [entry("g1", "LLM", 0), entry("g2", "agent", 1)]));
    put(set("cb", "alice", { kind: "collection", collectionId: "course-b" }, [entry("b1", "Agent", 0), entry("b2", "Harness", 1)]));
    put(set("ca", "alice", { kind: "collection", collectionId: "course-a" }, [entry("a1", "AGENT", 0), entry("a2", "Prompt", 1)]));
    put(set("x", "alice", { kind: "content", contentId: "c-alice" }, [entry("x1", "llm", 0)]));
    const ids = () => effective("alice", "c-alice").map((e) => e.id);
    expect(ids()).toEqual(["x1", "a1", "a2", "b2"]);
    expect(ids()).toEqual(ids());
    put(set("x", "alice", { kind: "content", contentId: "c-alice" }, []));
    expect(ids()).toEqual(["a1", "a2", "b2", "g1"]);
  });
});
