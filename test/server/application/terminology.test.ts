import { afterEach, describe, expect, it } from "vitest";
import { TerminologyService } from "../../../src/server/application/terminology.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { TERMINOLOGY_MAX_ENTRIES } from "../../../src/shared/defaults.ts";
import { BOB, createHarness, createLocalContent, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";
import { countRows } from "../../tools/sqlite.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

function setup() {
  const h = createHarness();
  open.push(h);
  const service = new TerminologyService({ repository: h.repository, newId: h.newId });
  return { h, service };
}

function collectionWith(h: Harness, contentId: string, addedAt: number): string {
  const id = h.newId();
  h.repository.withTransaction((scope) => {
    scope.collections.insert({ id, userId: LOCAL.userId, name: `course ${addedAt}`, createdAt: addedAt, updatedAt: addedAt });
    scope.collections.addItem(LOCAL.userId, { id: h.newId(), collectionId: id, contentId, position: 0, addedAt });
  });
  return id;
}

function codeOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : String(error);
  }
  return undefined;
}

const effective = (h: Harness, contentId: string) => h.repository.withTransaction((scope) => scope.terminology.effectiveFor(LOCAL.userId, contentId));

describe("TerminologyService", () => {
  it("replaces a scope's whole set, numbering entries by position, and removes it when emptied", () => {
    const { h, service } = setup();
    expect(service.get(LOCAL, "global")).toEqual({ scope: "global", entries: [] });
    const first = service.put(LOCAL, "global", { entries: [{ term: " RAG ", translation: "检索增强生成" }, { term: "Agent" }] });
    expect(first.entries.map(({ ordinal, term, normalizedKey }) => ({ ordinal, term, normalizedKey }))).toEqual([
      { ordinal: 0, term: "RAG", normalizedKey: "rag" },
      { ordinal: 1, term: "Agent", normalizedKey: "agent" },
    ]);
    expect(service.get(LOCAL, "global")).toEqual(first);
    const second = service.put(LOCAL, "global", { entries: [{ term: "LLM", rule: "keep_original" }] });
    expect(service.get(LOCAL, "global").entries).toEqual(second.entries);
    expect(countRows(h.db, "terminology_entry")).toBe(1);
    service.put(LOCAL, "global", { entries: [] });
    expect(countRows(h.db, "terminology_set")).toBe(0);
    // Another user's global set is separate.
    expect(service.get(BOB, "global").entries).toEqual([]);
  });

  it("rejects over-full sets and duplicate keys without writing anything", () => {
    const { h, service } = setup();
    service.put(LOCAL, "global", { entries: [{ term: "kept" }] });
    const tooMany = Array.from({ length: TERMINOLOGY_MAX_ENTRIES + 1 }, (_, i) => ({ term: `term ${i}` }));
    expect(codeOf(() => service.put(LOCAL, "global", { entries: tooMany }))).toBe("invalid_request");
    expect(codeOf(() => service.put(LOCAL, "global", { entries: [{ term: "RAG" }, { term: " rag " }] }))).toBe("invalid_request");
    expect(service.get(LOCAL, "global").entries.map((entry) => entry.term)).toEqual(["kept"]);
    expect(countRows(h.db, "terminology_entry")).toBe(1);
  });

  it("accepts only the owner's own collection and content scopes and well-formed scope names", () => {
    const { h, service } = setup();
    const contentId = createLocalContent(h);
    const collectionId = collectionWith(h, contentId, 1);
    expect(codeOf(() => service.put(BOB, `content:${contentId}`, { entries: [{ term: "x" }] }))).toBe("not_found");
    expect(codeOf(() => service.get(BOB, `collection:${collectionId}`))).toBe("not_found");
    expect(codeOf(() => service.get(LOCAL, "content:nope"))).toBe("not_found");
    expect(codeOf(() => service.get(LOCAL, "everything"))).toBe("invalid_request");
    expect(service.put(LOCAL, `collection:${collectionId}`, { entries: [{ term: "x" }] }).scope).toBe(`collection:${collectionId}`);
  });

  it("merges three scopes with content winning, deterministically and within three full sets", () => {
    const { h, service } = setup();
    const contentId = createLocalContent(h);
    const earlier = collectionWith(h, contentId, 10);
    const later = collectionWith(h, contentId, 20);
    service.put(LOCAL, "global", { entries: [{ term: "RAG", translation: "global" }, { term: "LLM", translation: "global" }] });
    service.put(LOCAL, `collection:${later}`, { entries: [{ term: "Agent", translation: "later" }, { term: "llm", translation: "later" }] });
    service.put(LOCAL, `collection:${earlier}`, { entries: [{ term: "agent", translation: "earlier" }] });
    service.put(LOCAL, `content:${contentId}`, { entries: [{ term: "rag", translation: "content" }] });
    const merged = effective(h, contentId).map(({ term, translation }) => ({ term, translation }));
    expect(merged).toEqual([
      { term: "rag", translation: "content" },
      { term: "agent", translation: "earlier" },
      { term: "llm", translation: "later" },
    ]);
    expect(effective(h, contentId)).toEqual(effective(h, contentId));

    // Full sets in every scope with distinct keys: the merge keeps all, never more than 3×.
    const full = (prefix: string) => ({ entries: Array.from({ length: TERMINOLOGY_MAX_ENTRIES }, (_, i) => ({ term: `${prefix} ${i}` })) });
    service.put(LOCAL, "global", full("g"));
    service.put(LOCAL, `collection:${earlier}`, full("c"));
    service.put(LOCAL, `collection:${later}`, { entries: [] });
    service.put(LOCAL, `content:${contentId}`, full("k"));
    const all = effective(h, contentId);
    expect(all).toHaveLength(3 * TERMINOLOGY_MAX_ENTRIES);
    expect(all[0]?.term).toBe("k 0");
    expect(all[TERMINOLOGY_MAX_ENTRIES]?.term).toBe("c 0");
    expect(effective(h, contentId)).toEqual(all);
  });
});
