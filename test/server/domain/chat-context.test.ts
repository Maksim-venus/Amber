import { describe, expect, it } from "vitest";
import {
  aliased,
  chatBudget,
  chooseChatMode,
  citationAliasTable,
  citedSegmentIds,
  compactionPrompt,
  planChatRequest,
  turnsToCompact,
  type ChatPlanInput,
  type ChatTurnText,
} from "../../../src/server/domain/chat-context.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { estimateTokens } from "../../../src/server/domain/token-estimate.ts";
import type { TranscriptSegment } from "../../../src/server/domain/transcript.ts";
import { CHAT_RECENT_TURNS, CHAT_RECENT_TURNS_MIN, CHAT_RETRIEVAL_NEIGHBOR_SEGMENTS, CONTEXT_SAFETY_RATIO } from "../../../src/shared/defaults.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";

const seg = (n: number) => `01J0000000000000000000${String(n).padStart(4, "0")}` as SegmentId;

function transcript(count: number, text = (i: number) => `这是第 ${i + 1} 句话，讲解课程里的一个知识点。`): TranscriptSegment[] {
  return Array.from({ length: count }, (_, ordinal) => ({
    id: seg(ordinal + 1),
    revisionId: "r1",
    ordinal,
    startMs: ordinal * 10_000,
    endMs: ordinal * 10_000 + 9_000,
    text: text(ordinal),
    sourceSegmentIds: [],
  }));
}

function input(overrides: Partial<ChatPlanInput> = {}): ChatPlanInput {
  return {
    contextWindowTokens: 128_000,
    outputLanguage: "zh-CN",
    revisionId: "r1",
    segments: transcript(20),
    chapters: [],
    turns: [],
    question: "这节课讲了什么？",
    ...overrides,
  };
}

const turn = (n: number, size = 1): ChatTurnText => ({ question: `问题 ${n} ${"问".repeat(size)}`, answer: `回答 ${n} ${"答".repeat(size)} [[seg:${seg(1)}]]` });
const lastText = (plan: ReturnType<typeof planChatRequest>) => {
  const last = plan.messages.at(-1)?.content[0];
  return last?.type === "text" ? last.text : "";
};

describe("chat budget and mode", () => {
  it("budgets the safe share of the context window", () => {
    expect(chatBudget(10_000)).toBe(Math.floor(10_000 * CONTEXT_SAFETY_RATIO));
  });

  it("uses the whole aliased transcript when it fits", () => {
    const plan = planChatRequest(input({ summary: `总结 [[seg:${seg(3)}]] 与 [[seg:01JXXXXXXXXXXXXXXXXXXXXXXX]]` }));
    expect(plan.mode).toBe("full");
    expect(plan.table.entries).toHaveLength(20);
    expect(plan.system).toContain("【逐字稿】");
    expect(plan.system).toContain("[[s20]] 这是第 20 句话");
    expect(plan.system).toContain("总结 [[s3]] 与 ");
    expect(plan.system).not.toContain("[[seg:");
    expect(plan.system).toContain("回答使用 简体中文");
    expect(lastText(plan)).toBe("这节课讲了什么？");
    expect(plan.estimatedTokens).toBeGreaterThan(estimateTokens(plan.system));
  });

  it("switches to retrieval once the transcript no longer fits the budget", () => {
    const long = input({ segments: transcript(400), contextWindowTokens: 4_000 });
    expect(chooseChatMode(long)).toBe("retrieval");
    expect(chooseChatMode({ ...long, contextWindowTokens: 1_000_000 })).toBe("full");
  });
});

describe("retrieval mode", () => {
  const long = (overrides: Partial<ChatPlanInput> = {}) => input({ segments: transcript(400), contextWindowTokens: 6_000, ...overrides });

  it("shows ranked hits with their neighbours in time order, numbered s1..sN", () => {
    const plan = planChatRequest(long(), [seg(300), seg(10)]);
    expect(plan.mode).toBe("retrieval");
    const shown = plan.table.entries.map((entry) => entry.citation.segmentId);
    const around = (n: number) => Array.from({ length: 2 * CHAT_RETRIEVAL_NEIGHBOR_SEGMENTS + 1 }, (_, i) => seg(n - CHAT_RETRIEVAL_NEIGHBOR_SEGMENTS + i));
    expect(shown).toEqual([...around(10), ...around(300)]);
    expect(plan.table.entries.map((entry) => entry.alias)).toEqual(shown.map((_, i) => i + 1));
    expect(plan.system).toContain("【相关片段】");
    expect(plan.system.indexOf("第 10 句")).toBeLessThan(plan.system.indexOf("第 300 句"));
    expect(plan.system).not.toContain("【逐字稿】");
  });

  it("adds the chapter table and the chapter at the player position, else at the quote", () => {
    const chapters = [
      { startMs: 0, endMs: 2_000_000, title: "开场" },
      { startMs: 2_000_000, endMs: 4_000_000, title: "核心概念" },
    ];
    const byPosition = planChatRequest(long({ chapters, positionMs: 2_500_000 }), []);
    expect(byPosition.system).toContain("【章节目录】\n- 0:00 开场\n- 33:20 核心概念");
    expect(byPosition.system).toContain("【当前章节】核心概念");
    expect(byPosition.table.entries.some((entry) => entry.citation.segmentId === seg(251))).toBe(true);

    const byQuote = planChatRequest(long({ chapters, quote: { segmentId: seg(5), text: "这是第 5 句话" } }), []);
    expect(byQuote.system).toContain("【当前章节】开场");
    const quoteAlias = byQuote.table.aliasOf(seg(5));
    expect(lastText(byQuote)).toBe(`【用户选中的原文】[[s${quoteAlias}]] 这是第 5 句话\n这节课讲了什么？`);

    const none = planChatRequest(long({ chapters }), []);
    expect(none.system).not.toContain("【当前章节】");
  });

  it("refuses with context_length when even the fixed part exceeds the budget", () => {
    let caught: unknown;
    try {
      planChatRequest(long({ contextWindowTokens: 600, summary: "长".repeat(2_000) }), []);
    } catch (error) {
      caught = error;
    }
    expect(isAmberError(caught) && caught.appError.code).toBe("llm_capability.context_length");
  });
});

describe("metadata mode", () => {
  const metadata = { title: "第一讲", source: "youtube" as const, channelTitle: "某频道", durationMs: 600_000, publishedAt: Date.UTC(2026, 0, 2), references: [] as string[] };
  const noTranscript = (overrides: Partial<ChatPlanInput> = {}): ChatPlanInput => {
    const { revisionId: _revision, ...rest } = input({ segments: [], metadata, ...overrides });
    return rest;
  };

  it("uses the `chat.system.metadata` prompt with the basic facts and an empty alias table", () => {
    const plan = planChatRequest(noTranscript());
    expect(plan.mode).toBe("metadata");
    expect(chooseChatMode(noTranscript())).toBe("metadata");
    expect(plan.table.entries).toEqual([]);
    expect(plan.system).toContain("【基本信息】\n标题：第一讲\n来源：YouTube · 某频道\n时长：10:00\n发布日期：2026-01-02");
    expect(plan.system).not.toContain("【参考文本】");
  });

  it("fits reference texts into the budget, cutting the last one, and drops stored markers from history", () => {
    const long = "参考文本内容。".repeat(4_000);
    const plan = planChatRequest(
      noTranscript({
        contextWindowTokens: 8_000,
        metadata: { ...metadata, references: ["短讲义。", long] },
        turns: [{ question: "之前的问题", answer: `之前的回答 [[seg:${seg(1)}]]` }],
      }),
    );
    expect(plan.system).toContain("【参考文本】\n短讲义。\n参考文本内容。");
    expect(plan.system).not.toContain(long);
    expect(plan.estimatedTokens).toBeLessThanOrEqual(Math.floor(8_000 * CONTEXT_SAFETY_RATIO));
    expect(JSON.stringify(plan.messages)).not.toContain("[[s");
  });

  it("refuses with context_length when even the basic facts exceed the budget", () => {
    try {
      planChatRequest(noTranscript({ contextWindowTokens: 100 }));
      expect.unreachable();
    } catch (error) {
      expect(isAmberError(error) && error.appError.code).toBe("llm_capability.context_length");
    }
  });
});

describe("history and compaction", () => {
  it("carries every uncompacted turn while they fit, with stored markers renumbered", () => {
    const plan = planChatRequest(input({ turns: [turn(1), turn(2)], compaction: `早先结论 [[seg:${seg(2)}]]` }));
    expect(plan.overBudget).toBe(false);
    expect(plan.carriedTurns).toBe(2);
    expect(plan.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    const answer = plan.messages[1]?.content[0];
    expect(answer?.type === "text" && answer.text).toBe("回答 1 答 [[s1]]");
    expect(plan.system).toContain("【此前对话的压缩摘要】\n早先结论 [[s2]]");
  });

  it("flags compaction when the history does not fit and keeps at least the minimum turns", () => {
    const turns = Array.from({ length: 10 }, (_, i) => turn(i, 3_000));
    const plan = planChatRequest(input({ contextWindowTokens: 30_000, turns }));
    expect(plan.overBudget).toBe(true);
    expect(plan.carriedTurns).toBe(CHAT_RECENT_TURNS_MIN);
    expect(turnsToCompact(turns)).toHaveLength(10 - CHAT_RECENT_TURNS);
    expect(turnsToCompact(turns.slice(0, CHAT_RECENT_TURNS))).toEqual([]);
  });

  it("renders the compaction prompt with the cited sentences renumbered", () => {
    const turns = [turn(1)];
    const ids = citedSegmentIds([`旧 [[seg:${seg(4)}]]`, ...turns.map((t) => t.answer)]);
    expect(ids).toEqual([seg(4), seg(1)]);
    const table = citationAliasTable(ids.map((segmentId) => ({ transcriptRevisionId: "r1", segmentId, text: "句" })));
    const prompt = compactionPrompt({ compaction: `旧 [[seg:${seg(4)}]]`, turns, outputLanguage: "zh-CN" }, table);
    expect(prompt).toContain("【已有压缩摘要】\n旧 [[s1]]");
    expect(prompt).toContain("用户：问题 1 问\n助手：回答 1 答 [[s2]]");
    expect(prompt).toContain("不超过 1500 字");
    expect(aliased("x [[unresolved:s9]] y", table)).toBe("x  y");
  });
});
