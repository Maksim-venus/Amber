import { afterEach, describe, expect, it } from "vitest";
import type { CollectionSummaryRevision } from "../../../../src/server/domain/artifact.ts";
import { canonicalJson } from "../../../../src/server/domain/canonical-json.ts";
import type { LlmRequest, LlmStreamEvent } from "../../../../src/server/domain/llm.ts";
import type { ModelRef } from "../../../../src/server/domain/model-ref.ts";
import { normalizeTermKey } from "../../../../src/server/domain/terminology.ts";
import { BUILTIN_SUMMARY_TEMPLATES, COLLECTION_ROLLUP_GOAL } from "../../../../src/server/domain/prompts.ts";
import type { TranscriptRevision, TranscriptSegment } from "../../../../src/server/domain/transcript.ts";
import { transact } from "../../../../src/server/pipeline/publish.ts";
import { CollectionSummaryStageExecutor } from "../../../../src/server/pipeline/stages/collection-summary.ts";
import { createTask } from "../../../../src/server/pipeline/task-state.ts";
import { COLLECTION_PARTIAL_SIZE, CONTEXT_SAFETY_RATIO } from "../../../../src/shared/defaults.ts";
import type { SegmentId } from "../../../../src/shared/ids.ts";
import { FakeLlmProvider, reply } from "../../../fixtures/llm/fake-llm.ts";
import {
  configureLlm,
  createHarness,
  createLocalContent,
  LOCAL,
  stageRunsOf,
  stageStatuses,
  waitFor,
  workUnitsOf,
  type Harness,
} from "../../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close();
});

const CORE = BUILTIN_SUMMARY_TEMPLATES[0] as (typeof BUILTIN_SUMMARY_TEMPLATES)[number];

function promptOf(request: LlmRequest): string {
  const part = request.messages[0]?.content[0];
  return part?.type === "text" ? part.text : "";
}

type Kind = "partial" | "carry" | "final" | "repair";

function kindOf(request: LlmRequest): Kind {
  const prompt = promptOf(request);
  if (prompt.startsWith("以下引用标记")) return "repair";
  if (prompt.startsWith("你在为一门课程做连贯的归纳")) return "partial";
  if (prompt.startsWith("把「已有压缩摘要」")) return "carry";
  return "final";
}

function aliasesAfter(request: LlmRequest, marker: string): number[] {
  const prompt = promptOf(request);
  return [...prompt.slice(prompt.lastIndexOf(marker)).matchAll(/\[\[s(\d+)\]\]/g)].map((match) => Number(match[1]));
}

/** Partials cite every alias of their group, carries the first one, the final every partial's citations. */
function provider(): FakeLlmProvider {
  const fake = new FakeLlmProvider();
  fake.script(
    ...Array.from({ length: 100 }, () => (request: LlmRequest) =>
      (async function* (): AsyncGenerator<LlmStreamEvent> {
        const kind = kindOf(request);
        const cite = (aliases: number[]) => aliases.map((alias) => `[[s${alias}]]`).join(" ");
        if (kind === "partial") yield* reply(`本组 ${cite(aliasesAfter(request, "【本组内容】"))}`);
        else if (kind === "carry") yield* reply(`压缩 ${cite(aliasesAfter(request, "【新增归纳】").slice(0, 1))}`);
        else if (kind === "final") yield* reply(`## 这门课在讲什么\n跨讲 ${cite(aliasesAfter(request, "【各组归纳】"))}`);
        else yield* reply("{}");
      })(),
    ),
  );
  return fake;
}

interface Lecture {
  contentId: string;
  itemId: string;
  revision: TranscriptRevision;
  segments: TranscriptSegment[];
  summaryRevisionId: string;
}

interface Setup {
  h: Harness;
  fake: FakeLlmProvider;
  modelRef: ModelRef;
  collectionId: string;
  lectures: Lecture[];
}

/** A collection of `count` lectures, each with a 3-sentence primary and a `summary.core` current citing two of them. */
function setup(count: number, options: { contextWindowTokens?: number } = {}): Setup {
  const fake = provider();
  const h = createHarness({ llmProviders: [fake], executors: {} });
  open.push(h);
  h.executors.collection_summary = new CollectionSummaryStageExecutor({ repository: h.repository, newId: h.newId });
  const modelRef = configureLlm(h);
  if (options.contextWindowTokens !== undefined) {
    h.db
      .prepare("UPDATE model_capability SET limits_user_override_json = ? WHERE profile_id = ?")
      .run(JSON.stringify({ contextWindowTokens: options.contextWindowTokens, maxOutputTokens: 10 }), modelRef.providerProfileId);
  }
  const collectionId = h.newId();
  const lectures: Lecture[] = [];
  h.repository.withTransaction((scope) => {
    scope.summaryTemplates.syncBuiltin(
      BUILTIN_SUMMARY_TEMPLATES.map((template) => ({ id: template.id, name: template.nameKey, versions: [{ version: template.version, prompt: template.prompt }] })),
      1,
    );
    scope.collections.insert({ id: collectionId, userId: LOCAL.userId, name: "生成式软件工程", createdAt: 1, updatedAt: 1 });
  });
  for (let k = 0; k < count; k += 1) {
    const contentId = createLocalContent(h);
    const revisionId = h.newId();
    const segments: TranscriptSegment[] = [0, 1, 2].map((ordinal) => ({
      id: h.newId() as SegmentId,
      revisionId,
      ordinal,
      startMs: ordinal * 1000,
      endMs: ordinal * 1000 + 900,
      text: `第 ${k + 1} 讲第 ${ordinal + 1} 句`,
      sourceSegmentIds: [],
    }));
    const revision: TranscriptRevision = {
      id: revisionId,
      contentId,
      kind: "imported",
      language: "zh-CN",
      timingFidelity: "segment_only",
      generation: { kind: "imported", format: "srt" },
      segmentCount: 3,
      createdAt: 1,
    };
    const summaryRevisionId = h.newId();
    const itemId = h.newId();
    h.repository.withTransaction((scope) => {
      scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
      scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, revisionId, 2);
      const { artifactId } = scope.summaries.insertRevision(LOCAL.userId, {
        contentId,
        templateId: CORE.id,
        artifactId: h.newId(),
        revision: {
          id: summaryRevisionId,
          provenance: { inputs: [{ kind: "transcriptRevision", id: revisionId }], promptRef: { id: CORE.id, version: CORE.version }, createdAt: 1 },
          quality: "normal",
          body: `## 摘要\n要点一 [[seg:${segments[0]?.id}]]，要点二 [[seg:${segments[2]?.id}]]`,
          citations: [0, 2].map((i) => ({ transcriptRevisionId: revisionId, segmentId: segments[i]?.id as SegmentId })),
        },
      });
      scope.summaries.setCurrent(LOCAL.userId, artifactId, summaryRevisionId);
      scope.collections.addItem(LOCAL.userId, { id: itemId, collectionId, contentId, position: k, addedAt: 1 });
    });
    lectures.push({ contentId, itemId, revision, segments, summaryRevisionId });
  }
  return { h, fake, modelRef, collectionId, lectures };
}

function summarize(s: Setup): string {
  const request = {
    requestSchemaVersion: 1,
    kind: "summarize_collection",
    modelRef: s.modelRef,
    outputLanguage: "zh-CN",
    inputItems: s.lectures.map((lecture, position) => ({
      collectionItemId: lecture.itemId,
      contentId: lecture.contentId,
      summaryRevisionId: lecture.summaryRevisionId,
      transcriptRevisionId: lecture.revision.id,
      position,
    })),
  };
  return transact(s.h.repository, s.h.bus, (scope, outbox) =>
    createTask(scope, outbox, {
      task: { id: s.h.newId(), userId: LOCAL.userId, collectionId: s.collectionId, kind: "summarize_collection", requestJson: canonicalJson(request), createdAt: 1 },
      sourceKind: undefined,
      newId: s.h.newId,
    }).id,
  );
}

async function settled(h: Harness, taskId: string): Promise<string> {
  await waitFor(() => ["succeeded", "failed"].includes(stageStatuses(h, taskId)["collection_summary"] ?? ""));
  return stageStatuses(h, taskId)["collection_summary"] as string;
}

const resultOf = (h: Harness, taskId: string) =>
  JSON.parse(stageRunsOf(h, taskId).at(-1)?.resultJson ?? "{}") as Record<string, unknown>;

describe("collection summary stage", () => {
  it("twelve lectures roll in three groups; the final cites across lectures and every citation resolves to its own Content", async () => {
    const s = setup(12);
    s.h.repository.withTransaction((scope) =>
      scope.terminology.put({
        id: s.h.newId(),
        userId: LOCAL.userId,
        scope: { kind: "collection", collectionId: s.collectionId },
        entries: [{ id: s.h.newId(), ordinal: 0, term: "RAG", normalizedKey: normalizeTermKey("RAG"), translation: "检索增强生成" }],
      }),
    );
    const taskId = summarize(s);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("succeeded");

    expect(Math.ceil(12 / COLLECTION_PARTIAL_SIZE)).toBe(3);
    expect(workUnitsOf(s.h, taskId).map((unit) => unit.key)).toEqual([
      "rollup:partial:0",
      "rollup:carry:0",
      "rollup:partial:1",
      "rollup:carry:1",
      "rollup:partial:2",
      "rollup:carry:2",
      "rollup:final",
    ]);
    const firstPartial = promptOf(s.fake.calls[0]?.request as LlmRequest);
    expect(firstPartial).toContain(COLLECTION_ROLLUP_GOAL);
    expect(firstPartial).toContain("【术语表】\nRAG = 检索增强生成");
    // Lectures are numbered across the collection; aliases are renumbered across lectures.
    expect(firstPartial).toContain("【第 1 讲】\n## 摘要\n要点一 [[s1]]，要点二 [[s2]]");
    expect(promptOf(s.fake.calls[2]?.request as LlmRequest)).toContain("【第 6 讲】\n## 摘要\n要点一 [[s11]]，要点二 [[s12]]");
    expect(promptOf(s.fake.calls[6]?.request as LlmRequest).startsWith("下面是一门课程各组内容的归纳与整体压缩摘要")).toBe(true);

    const result = resultOf(s.h, taskId);
    expect(result).toMatchObject({ groups: 3, reasons: [] });
    const revision = s.h.repository.withTransaction((scope) => scope.collectionSummaries.getCurrent(LOCAL.userId, s.collectionId)) as CollectionSummaryRevision;
    expect(revision.id).toBe(result["revisionId"]);
    expect(revision.quality).toBe("normal");
    expect(revision.provenance.promptRef).toEqual({ id: "rollup.final.collection", version: 1 });
    // A published rollup summary counts as a change of the collection.
    expect(s.h.repository.withTransaction((scope) => scope.collections.get(LOCAL.userId, s.collectionId))?.updatedAt).toBe(revision.provenance.createdAt);
    expect(revision.inputItems).toHaveLength(12);
    expect(revision.provenance.inputs[0]).toEqual({
      kind: "collectionItemSnapshot",
      collectionItemId: s.lectures[0]?.itemId,
      contentId: s.lectures[0]?.contentId,
      summaryRevisionId: s.lectures[0]?.summaryRevisionId,
      transcriptRevisionId: s.lectures[0]?.revision.id,
      position: 0,
    });

    // Every lecture's two cited sentences reach the final, each resolving to that lecture's own transcript.
    const markers = [...revision.body.matchAll(/\[\[seg:([^\]]+)\]\]/g)].map((match) => match[1] as string);
    expect(new Set(markers).size).toBe(24);
    for (const lecture of s.lectures) {
      for (const index of [0, 2]) {
        const id = lecture.segments[index]?.id as string;
        expect(markers).toContain(id);
        expect(revision.citations).toContainEqual({ transcriptRevisionId: lecture.revision.id, segmentId: id });
        const segment = s.h.repository.withTransaction((scope) => scope.transcripts.getSegment(LOCAL.userId, id));
        expect(segment?.revisionId).toBe(lecture.revision.id);
      }
    }
    const contentsCited = new Set(revision.citations.map((citation) => s.lectures.find((lecture) => lecture.revision.id === citation.transcriptRevisionId)?.contentId));
    expect(contentsCited.size).toBe(12);

    const partials = s.h.repository.withTransaction((scope) => scope.rollupPartials.listByOwnerRevision(LOCAL.userId, revision.id));
    expect(partials).toHaveLength(3);
    expect(revision.partialIds).toEqual(partials.map((partial) => partial.id));
    expect(partials.map((partial) => partial.inputs.length)).toEqual([5, 5, 2]);
    expect(partials[2]?.citations).toHaveLength(4);
    const usage = s.h.db.prepare("SELECT feature, COUNT(*) AS n FROM token_usage WHERE artifact_revision_id IS NOT NULL GROUP BY feature").all();
    expect(usage).toEqual([{ feature: "collection_summary", n: 7 }]);
  });

  it("fails with context_length when a group of lectures does not fit, without splitting it further", async () => {
    // Room for the partial prompt skeleton but not for five lectures plus the goal.
    const s = setup(6, { contextWindowTokens: Math.ceil((400 + 10) / CONTEXT_SAFETY_RATIO) });
    const taskId = summarize(s);
    s.h.scheduler.start();
    expect(await settled(s.h, taskId)).toBe("failed");
    expect(stageRunsOf(s.h, taskId).at(-1)?.error?.code).toBe("llm_capability.context_length");
    expect(s.fake.calls).toHaveLength(0);
    // Nothing was published, so the collection has not changed.
    expect(s.h.repository.withTransaction((scope) => scope.collections.get(LOCAL.userId, s.collectionId))?.updatedAt).toBe(1);
  });
});
