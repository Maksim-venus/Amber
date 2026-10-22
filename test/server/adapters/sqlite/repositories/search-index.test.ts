import { afterEach, describe, expect, it } from "vitest";
import type { SearchIndexQuery } from "../../../../../src/server/ports/repository.ts";
import { insertSummary } from "../../../../fixtures/pipeline/summary-data.ts";
import { BOB, createHarness, LOCAL, type Harness } from "../../../../fixtures/pipeline/harness.ts";
import { projectionSnapshot, seedContent } from "../../../../fixtures/search/corpus.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close();
});

function harness(): Harness {
  const h = createHarness();
  open.push(h);
  return h;
}

const query = (h: Harness, partial: Partial<SearchIndexQuery> & Pick<SearchIndexQuery, "terms">, owner = LOCAL.userId) =>
  h.repository.withTransaction((scope) =>
    scope.search.query(owner, { mode: "fts", scope: { kind: "global" }, groupLimit: 20, likeLimit: 200, ...partial }),
  );

describe("sqlite search index", () => {
  it("projects title, primary segments, current summaries (without citation markers) and reference texts", () => {
    const h = harness();
    const seeded = seedContent(h, { title: "Gradient Descent 入门", lines: ["今天讲梯度下降", "学习率很重要"], reference: "课后阅读：凸优化" });
    insertSummary(h, { contentId: seeded.contentId, transcriptRevisionId: seeded.revisionId as string, citations: [{ transcriptRevisionId: seeded.revisionId as string, segmentId: seeded.segmentIds[0] as never }] });
    h.repository.withTransaction((scope) => scope.search.syncContent(LOCAL.userId, seeded.contentId));
    const kinds = (projectionSnapshot(h) as Array<{ kind: string; text: string }>).map((row) => `${row.kind}:${row.text}`);
    expect(kinds).toEqual(expect.arrayContaining(["title:Gradient Descent 入门", "segment:今天讲梯度下降", "segment:学习率很重要", "reference:课后阅读：凸优化"]));
    const summary = (projectionSnapshot(h) as Array<{ kind: string; text: string }>).find((row) => row.kind === "summary");
    expect(summary?.text).not.toContain("[[seg:");
    expect(query(h, { terms: ["seg:"], mode: "fts" }).filter((hit) => hit.kind === "summary")).toEqual([]);
  });

  it("matches English substrings through FTS and two-character Chinese words through LIKE", () => {
    const h = harness();
    const seeded = seedContent(h, { title: "Gradient Descent", lines: ["梯度下降的直觉", "无关的一句"] });
    expect(query(h, { terms: ["radient"] })).toEqual([{ kind: "title", contentId: seeded.contentId, text: "Gradient Descent" }]);
    const short = query(h, { terms: ["梯度"], mode: "like" });
    expect(short).toEqual([
      { kind: "segment", contentId: seeded.contentId, transcriptRevisionId: seeded.revisionId, segmentId: seeded.segmentIds[0], startMs: 0, text: "梯度下降的直觉" },
    ]);
  });

  it("treats quotes, operators, wildcards and LIKE metacharacters as literal text", () => {
    const h = harness();
    seedContent(h, { lines: ['他说 "OR" 不是运算符', "100%_完成", "普通的一句话"] });
    expect(query(h, { terms: ['"OR"'] })).toHaveLength(1);
    expect(query(h, { terms: ["OR"], mode: "like" })).toHaveLength(1);
    expect(query(h, { terms: ["NOT"] })).toEqual([]);
    expect(query(h, { terms: ["的一*"] })).toEqual([]);
    expect(query(h, { terms: ["%_"], mode: "like" })).toHaveLength(1);
    expect(query(h, { terms: ["_"], mode: "like" })).toHaveLength(1);
    expect(query(h, { terms: ["%"], mode: "like" })).toHaveLength(1);
  });

  it("requires every term and keeps each kind within the group limit", () => {
    const h = harness();
    seedContent(h, { lines: Array.from({ length: 30 }, (_, index) => `重复出现的检索句 ${index}`) });
    expect(query(h, { terms: ["检索句", "17"], mode: "like" })).toHaveLength(1);
    expect(query(h, { terms: ["重复出现"], groupLimit: 5 })).toHaveLength(5);
    expect(query(h, { terms: ["重复"], mode: "like", groupLimit: 5 })).toHaveLength(5);
    expect(query(h, { terms: ["重复"], mode: "like", likeLimit: 3 })).toHaveLength(3);
  });

  it("scopes library away from collections and a collection scope to its members", () => {
    const h = harness();
    const inside = seedContent(h, { title: "机器学习 第一讲" });
    seedContent(h, { title: "机器学习 番外" });
    const collection = h.collections.create(LOCAL, { name: "机器学习 课程" });
    h.repository.withTransaction((scope) => scope.collections.addItem(LOCAL.userId, { id: h.newId(), collectionId: collection.id, contentId: inside.contentId, position: 0, addedAt: 1 }));
    expect(query(h, { terms: ["机器学习"] }).map((hit) => hit.kind).sort()).toEqual(["collection", "title", "title"]);
    expect(query(h, { terms: ["机器学习"], scope: { kind: "library" } }).map((hit) => hit.kind)).toEqual(["title", "title"]);
    expect(query(h, { terms: ["机器学习"], scope: { kind: "collection", collectionId: collection.id } })).toEqual([
      { kind: "title", contentId: inside.contentId, text: "机器学习 第一讲" },
    ]);
  });

  it("never returns another owner's rows", () => {
    const h = harness();
    seedContent(h, { title: "只属于本地用户的标题" });
    expect(query(h, { terms: ["本地用户"] }, BOB.userId)).toEqual([]);
    expect(query(h, { terms: ["本地用户"] })).toHaveLength(1);
  });

  it("ranks a revision's segments by question trigrams for chat retrieval", () => {
    const h = harness();
    const seeded = seedContent(h, { lines: ["向量数据库负责召回", "重排序模型提升精度", "今天天气不错"] });
    const other = seedContent(h, { lines: ["重排序模型在另一讲"] });
    const ids = h.repository.withTransaction((scope) => scope.search.matchSegments(LOCAL.userId, seeded.revisionId as string, "重排序模型是做什么的？", 2));
    expect(ids[0]).toBe(seeded.segmentIds[1]);
    expect(ids).not.toContain(other.segmentIds[0]);
    expect(h.repository.withTransaction((scope) => scope.search.matchSegments(BOB.userId, seeded.revisionId as string, "重排序模型", 2))).toEqual([]);
    expect(h.repository.withTransaction((scope) => scope.search.matchSegments(LOCAL.userId, seeded.revisionId as string, "啊？", 2))).toEqual([]);
  });

  it("removes a Content's or Collection's rows and rebuilds everything from the business tables", () => {
    const h = harness();
    const seeded = seedContent(h, { title: "要删除的内容", lines: ["一句话"] });
    const collection = h.collections.create(LOCAL, { name: "要删除的合集", description: "说明文字" });
    const before = projectionSnapshot(h);
    h.repository.withTransaction((scope) => scope.search.rebuild());
    expect(projectionSnapshot(h)).toEqual(before);
    h.repository.withTransaction((scope) => {
      scope.search.removeContent(LOCAL.userId, seeded.contentId);
      scope.search.removeCollection(LOCAL.userId, collection.id);
    });
    expect(projectionSnapshot(h)).toEqual([]);
  });

  it("reports itself unhealthy when emptied while data exists, and start-up repairs it", () => {
    const h = harness();
    expect(h.repository.withTransaction((scope) => scope.search.healthy())).toBe(true);
    seedContent(h, { title: "健康检查" });
    expect(h.repository.withTransaction((scope) => scope.search.healthy())).toBe(true);
    h.db.exec("DELETE FROM search_index");
    expect(h.repository.withTransaction((scope) => scope.search.healthy())).toBe(false);
    h.search.ensureReady();
    expect(h.repository.withTransaction((scope) => scope.search.healthy())).toBe(true);
    expect(projectionSnapshot(h)).toHaveLength(1);
  });

  it("never projects a Content in the trash, and stays healthy when only such Contents exist", () => {
    const h = harness();
    const seeded = seedContent(h, { title: "回收站里的讲次", lines: ["梯度下降"] });
    h.repository.withTransaction((scope) => {
      scope.contents.trash(LOCAL.userId, seeded.contentId, 5);
      scope.search.removeContent(LOCAL.userId, seeded.contentId);
    });
    expect(projectionSnapshot(h)).toEqual([]);
    expect(h.repository.withTransaction((scope) => scope.search.healthy())).toBe(true);
    // Neither re-deriving the one Content nor a full rebuild brings it back.
    h.repository.withTransaction((scope) => scope.search.syncContent(LOCAL.userId, seeded.contentId));
    h.repository.withTransaction((scope) => scope.search.rebuild());
    expect(projectionSnapshot(h)).toEqual([]);
    h.repository.withTransaction((scope) => {
      scope.contents.restore(LOCAL.userId, seeded.contentId);
      scope.search.syncContent(LOCAL.userId, seeded.contentId);
    });
    expect(query(h, { terms: ["回收站"], mode: "like" }).map((hit) => hit.kind)).toEqual(["title"]);
  });
});
