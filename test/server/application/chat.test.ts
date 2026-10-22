import { afterEach, describe, expect, it } from "vitest";
import type { ChatSendResult } from "../../../src/server/application/chat.ts";
import { amberError, isAmberError } from "../../../src/server/domain/errors.ts";
import type { LlmStreamEvent } from "../../../src/server/domain/llm.ts";
import type { ChatMessageRequest, ChatStreamEvent } from "../../../src/shared/dto/chat.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { FakeLlmProvider, reply } from "../../fixtures/llm/fake-llm.ts";
import { PipelineLlmProvider } from "../../fixtures/llm/pipeline-llm.ts";
import { configureChatModel, seedChatContent, setContextWindow } from "../../fixtures/pipeline/chat-data.ts";
import { BOB, createHarness, createLocalContent, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

function setup(provider: FakeLlmProvider = new FakeLlmProvider()) {
  h = createHarness({ llmProviders: [provider] });
  return { h, provider };
}

const never = () => new AbortController().signal;

async function collect(result: ChatSendResult): Promise<ChatStreamEvent[]> {
  if (result.kind !== "stream") {
    throw new Error("expected a stream");
  }
  const events: ChatStreamEvent[] = [];
  for await (const event of result.events) {
    events.push(event);
  }
  return events;
}

function errorCodeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : String(error);
  }
  return undefined;
}

const textOf = (events: readonly ChatStreamEvent[]) => events.flatMap((event) => (event.type === "answer.delta" ? [event.data.delta] : [])).join("");
const doneOf = (events: readonly ChatStreamEvent[]) => events.find((event) => event.type === "done")?.data as Extract<ChatStreamEvent, { type: "done" }>["data"];

describe("chat context of GET", () => {
  it("names why the context is unavailable: no model, unknown window", () => {
    const { h } = setup();
    const { contentId } = seedChatContent(h, 10);
    expect(h.chat.get(LOCAL, contentId, {})).toEqual({ thread: null, messages: [], context: { mode: "unavailable", reason: "no_model" } });
    const modelRef = configureChatModel(h, 128_000);
    setContextWindow(h, modelRef, undefined);
    expect(h.chat.get(LOCAL, contentId, modelRef).context).toEqual({ mode: "unavailable", reason: "context_window_unknown" });
    setContextWindow(h, modelRef, 128_000);
    const context = h.chat.get(LOCAL, contentId, modelRef).context;
    expect(context.mode).toBe("full");
    expect(context.estimatedTokens).toBeGreaterThan(0);
  });

  it("falls back to the chat model, then the default model of the settings", () => {
    const { h } = setup();
    const { contentId } = seedChatContent(h, 10);
    const modelRef = configureChatModel(h, 128_000);
    h.userSettings.patch(LOCAL, { defaultModelRef: modelRef });
    expect(h.chat.get(LOCAL, contentId, {}).context.mode).toBe("full");
  });

  it("hides another user's Content", () => {
    const { h } = setup();
    const { contentId } = seedChatContent(h, 3);
    expect(errorCodeOf(() => h.chat.get(BOB, contentId, {}))).toBe("not_found");
  });
});

describe("sending a message", () => {
  it("streams canonical citations, suggestions and usage, then stores the answer and writes back the chat model", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId, revisionId, segments } = seedChatContent(h, 10);
    const modelRef = configureChatModel(h, 128_000);
    provider.script({ events: reply("答案见 [[s2]]。\n<<<suggestions>>>\n- 追问一\n- 追问二\n<<<end>>>") });

    const events = await collect(h.chat.send(LOCAL, contentId, { text: "讲了什么？", modelRef }, undefined, never()));
    const seg2 = segments[1]?.id as string;
    expect(textOf(events)).toBe(`答案见 [[seg:${seg2}]]。`);
    expect(events.find((event) => event.type === "citation")?.data).toEqual({ transcriptRevisionId: revisionId, segmentId: seg2, startMs: 10_000 });
    expect(events.find((event) => event.type === "suggestions")?.data).toEqual({ items: ["追问一", "追问二"] });
    expect(events.find((event) => event.type === "usage")?.data).toEqual({ inputTokens: 12, outputTokens: 5 });
    const done = doneOf(events);
    expect(done.status).toBe("complete");
    expect(events.at(-1)?.type).toBe("done");

    const chat = h.chat.get(LOCAL, contentId, {});
    expect(chat.messages.map((message) => [message.role, message.status])).toEqual([
      ["user", "complete"],
      ["assistant", "complete"],
    ]);
    expect(chat.messages[1]).toMatchObject({
      id: done.messageId,
      text: `答案见 [[seg:${seg2}]]。`,
      citations: [{ transcriptRevisionId: revisionId, segmentId: seg2 }],
      suggestions: ["追问一", "追问二"],
      contextTranscriptRevisionId: revisionId,
      modelRef: { ...modelRef, providerNameSnapshot: "relay", modelDisplaySnapshot: "model-a" },
    });
    expect(h.userSettings.get(LOCAL).chatModelRef).toEqual(modelRef);
    const usage = h.repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId));
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ feature: "chat", chatMessageId: done.messageId, contentId, outcome: "succeeded" });
    expect(provider.calls[0]?.request.system).toContain("【逐字稿】");
  });

  it("sends the quoted sentence's stored text, never the client's, and refuses quotes from elsewhere", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId, revisionId, segments } = seedChatContent(h, 5);
    const other = seedChatContent(h, 2);
    const modelRef = configureChatModel(h, 128_000);
    const quote = { transcriptRevisionId: revisionId, segmentId: segments[2]?.id as SegmentId };
    await collect(h.chat.send(LOCAL, contentId, { text: "解释一下这句话", modelRef, quote }, undefined, never()));
    const turn = provider.calls[0]?.request.messages.at(-1)?.content[0];
    expect(turn?.type === "text" && turn.text).toBe(`【用户选中的原文】[[s3]] ${segments[2]?.text}\n解释一下这句话`);
    expect(h.chat.get(LOCAL, contentId, {}).messages[0]?.quote).toEqual(quote);

    const foreign = { transcriptRevisionId: other.revisionId, segmentId: other.segments[0]?.id as SegmentId };
    expect(errorCodeOf(() => h.chat.send(LOCAL, contentId, { text: "q", modelRef, quote: foreign }, undefined, never()))).toBe("invalid_request");
    const mismatched = { transcriptRevisionId: revisionId, segmentId: other.segments[0]?.id as SegmentId };
    expect(errorCodeOf(() => h.chat.send(LOCAL, contentId, { text: "q", modelRef, quote: mismatched }, undefined, never()))).toBe("invalid_request");
  });

  it("answers a Content without a transcript in the metadata mode: basic facts and reference texts, no citations, not grounded", async () => {
    const provider = new PipelineLlmProvider();
    const { h } = setup(provider);
    const modelRef = configureChatModel(h, 128_000);
    const contentId = createLocalContent(h);
    h.repository.withTransaction((scope) => {
      scope.contents.setMetadata(LOCAL.userId, contentId, { title: "第一讲：梯度下降", durationMs: 3_725_000 }, 2);
      scope.referenceTexts.insert(LOCAL.userId, { id: h.newId(), contentId, origin: "txt_import", text: "讲义：学习率决定每一步走多远。", createdAt: 3 });
    });
    const context = h.chat.get(LOCAL, contentId, modelRef).context;
    expect(context.mode).toBe("metadata");
    expect(context.estimatedTokens).toBeGreaterThan(0);

    const events = await collect(h.chat.send(LOCAL, contentId, { text: "这一讲讲什么？", modelRef, positionMs: 5_000 }, undefined, never()));
    expect(events.at(-1)).toMatchObject({ type: "done", data: { status: "complete" } });
    expect(events.some((event) => event.type === "citation")).toBe(false);
    const system = provider.calls[0]?.request.system ?? "";
    expect(system).toContain("字幕尚未就绪");
    expect(system).toContain("标题：第一讲：梯度下降");
    expect(system).toContain("来源：本地文件");
    expect(system).toContain("时长：1:02:05");
    expect(system).toContain("【参考文本】\n讲义：学习率决定每一步走多远。");
    expect(system).not.toContain("【逐字稿】");
    const answer = h.chat.get(LOCAL, contentId, modelRef).messages.at(-1);
    expect(answer).toMatchObject({ role: "assistant", status: "complete", citations: [] });
    expect(answer?.contextTranscriptRevisionId).toBeUndefined();
    expect(answer?.text.startsWith("字幕尚未就绪")).toBe(true);
  });

  it("switches from the metadata mode to full text once a primary revision exists", () => {
    const { h } = setup();
    const modelRef = configureChatModel(h, 128_000);
    const empty = createLocalContent(h);
    expect(h.chat.get(LOCAL, empty, modelRef).context.mode).toBe("metadata");
    const { contentId } = seedChatContent(h, 5);
    expect(h.chat.get(LOCAL, contentId, modelRef).context.mode).toBe("full");
  });

  it("refuses before anything is stored: unknown context window, foreign Content", () => {
    const { h } = setup();
    const modelRef = configureChatModel(h, 128_000);
    const send = (contentId: string, principal = LOCAL) => () => h.chat.send(principal, contentId, { text: "q", modelRef }, undefined, never());
    const { contentId } = seedChatContent(h, 3);
    expect(errorCodeOf(send(contentId, BOB))).toBe("not_found");
    setContextWindow(h, modelRef, undefined);
    expect(errorCodeOf(send(contentId))).toBe("llm_capability.context_window_unknown");
    expect(h.chat.get(LOCAL, contentId, {}).messages).toEqual([]);
  });

  it("marks an answer failed when the upstream fails, keeping what streamed", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    provider.script({ events: [{ type: "text_delta", delta: "半截" }], error: amberError("llm_failed", "boom", { code: "llm_failed.quota" }) });
    const events = await collect(h.chat.send(LOCAL, contentId, { text: "q", modelRef }, undefined, never()));
    expect(doneOf(events)).toMatchObject({ status: "failed", error: { code: "llm_failed.quota" } });
    expect(h.chat.get(LOCAL, contentId, {}).messages[1]).toMatchObject({ status: "failed", text: "半截" });
  });

  it("marks a refused answer failed with llm_failed.refused and keeps none of what streamed", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    provider.script({ events: [{ type: "text_delta", delta: "半截 [[s1]]" }, { type: "done", stopReason: "refused", raw: "refusal: cyber" }] });
    const events = await collect(h.chat.send(LOCAL, contentId, { text: "q", modelRef }, undefined, never()));
    expect(doneOf(events)).toMatchObject({ status: "failed", error: { code: "llm_failed.refused", upstreamMessage: "refusal: cyber" } });
    expect(h.chat.get(LOCAL, contentId, {}).messages[1]).toMatchObject({ status: "failed", text: "", citations: [] });
  });

  it("marks an aborted answer interrupted and records its usage as outcome_unknown", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    const controller = new AbortController();
    provider.script(async function* (): AsyncGenerator<LlmStreamEvent> {
      yield { type: "text_delta", delta: "已经说出的话" };
      controller.abort();
      yield { type: "text_delta", delta: "不会出现" };
      yield { type: "done", stopReason: "stop" };
    });
    const events = await collect(h.chat.send(LOCAL, contentId, { text: "q", modelRef }, undefined, controller.signal));
    expect(doneOf(events).status).toBe("interrupted");
    expect(h.chat.get(LOCAL, contentId, {}).messages[1]).toMatchObject({ status: "interrupted", text: "已经说出的话" });
    expect(h.repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId)).map((row) => row.outcome)).toEqual(["outcome_unknown"]);
  });

  it("replays an Idempotency-Key with the stored answer and calls no model again", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    const body: ChatMessageRequest = { text: "q", modelRef };
    await collect(h.chat.send(LOCAL, contentId, body, "key-1", never()));
    const replay = h.chat.send(LOCAL, contentId, body, "key-1", never());
    expect(replay.kind).toBe("replay");
    expect(replay.kind === "replay" && replay.message).toMatchObject({ role: "assistant", status: "complete", text: "ok" });
    expect(provider.calls).toHaveLength(1);
    expect(errorCodeOf(() => h.chat.send(LOCAL, contentId, { ...body, text: "other" }, "key-1", never()))).toBe("idempotency_conflict");
    expect(h.chat.get(LOCAL, contentId, {}).messages).toHaveLength(2);
  });

  it("clears the history; the next message starts a new thread", async () => {
    const { h } = setup();
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    await collect(h.chat.send(LOCAL, contentId, { text: "q", modelRef }, undefined, never()));
    expect(() => h.chat.clear(BOB, contentId)).toThrow();
    h.chat.clear(LOCAL, contentId);
    expect(h.chat.get(LOCAL, contentId, {})).toMatchObject({ thread: null, messages: [] });
    expect(h.repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId))).toHaveLength(1);
  });

  it("recovers answers a previous process left streaming", () => {
    const { h } = setup();
    const { contentId } = seedChatContent(h, 3);
    h.repository.withTransaction((scope) => {
      scope.chat.insertThread(LOCAL.userId, { id: "t", contentId });
      scope.chat.insertMessage(LOCAL.userId, { id: "a", threadId: "t", role: "assistant", text: "half", status: "streaming", citations: [], createdAt: 1 });
    });
    expect(h.chat.recoverInterrupted()).toBe(1);
    expect(h.chat.get(LOCAL, contentId, {}).messages[0]?.status).toBe("interrupted");
  });
});

describe("long transcripts and history", () => {
  it("answers a transcript beyond the budget in retrieval mode with resolvable citations", async () => {
    const provider = new PipelineLlmProvider();
    const { h } = setup(provider);
    const { contentId, segments } = seedChatContent(h, 1_800);
    const modelRef = configureChatModel(h, 8_000);
    expect(h.chat.get(LOCAL, contentId, modelRef).context.mode).toBe("retrieval");

    const events = await collect(h.chat.send(LOCAL, contentId, { text: "反向传播的要点是什么？", modelRef }, undefined, never()));
    expect(doneOf(events).status).toBe("complete");
    const system = provider.calls[0]?.request.system ?? "";
    expect(system).toContain("【相关片段】");
    expect(system).toContain("反向传播");
    expect(system).not.toContain("【逐字稿】");
    const answer = h.chat.get(LOCAL, contentId, {}).messages[1];
    expect(answer?.text).toMatch(/\[\[seg:[0-9A-Z]{26}\]\]/);
    const ids = new Set(segments.map((segment) => segment.id as string));
    expect(answer?.citations.length).toBeGreaterThan(0);
    expect(answer?.citations.every((citation) => ids.has(citation.segmentId))).toBe(true);
  });

  /** Ten finished turns of about 750 tokens each, stored directly. */
  function seedHistory(h: Harness, contentId: string, turns = 10): void {
    h.repository.withTransaction((scope) => {
      scope.chat.insertThread(LOCAL.userId, { id: "thread", contentId });
      for (let i = 0; i < turns; i += 1) {
        scope.chat.insertMessage(LOCAL.userId, { id: `u${String(i).padStart(2, "0")}`, threadId: "thread", role: "user", text: `问题 ${i}`, status: "complete", citations: [], createdAt: 10 + i * 2 });
        scope.chat.insertMessage(LOCAL.userId, {
          id: `v${String(i).padStart(2, "0")}`, threadId: "thread", role: "assistant", text: `回答 ${i} ${"长".repeat(500)}`, status: "complete", citations: [], createdAt: 11 + i * 2,
        });
      }
    });
  }

  it("folds older turns into a compaction when the history exceeds the budget", async () => {
    const provider = new PipelineLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 10);
    const modelRef = configureChatModel(h, 8_000);
    seedHistory(h, contentId);
    const events = await collect(h.chat.send(LOCAL, contentId, { text: "继续", modelRef }, undefined, never()));
    expect(doneOf(events).status).toBe("complete");
    expect(provider.kinds()).toEqual(["chat_compaction", "chat"]);
    const chat = h.chat.get(LOCAL, contentId, {});
    expect(chat.thread?.currentCompactionId).toBeDefined();
    const compaction = h.repository.withTransaction((scope) => scope.chat.getCompaction(LOCAL.userId, chat.thread?.currentCompactionId as string));
    expect(compaction).toMatchObject({ throughMessageId: "v03", promptRef: { id: "chat.compaction", version: 1 } });
    expect(provider.calls[1]?.request.system).toContain("【此前对话的压缩摘要】");
    const usage = h.repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId));
    expect(usage.find((row) => row.feature === "chat_compaction")?.artifactRevisionId).toBe(compaction?.id);
    expect(chat.messages).toHaveLength(22);
  });

  it("keeps answering with the most recent turns when compaction fails", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 10);
    const modelRef = configureChatModel(h, 8_000);
    seedHistory(h, contentId);
    provider.script({ events: [], error: amberError("llm_failed", "denied", { code: "llm_failed.auth" }) }, { events: reply("好的") });
    const events = await collect(h.chat.send(LOCAL, contentId, { text: "继续", modelRef }, undefined, never()));
    expect(doneOf(events).status).toBe("complete");
    expect(h.chat.get(LOCAL, contentId, {}).thread?.currentCompactionId).toBeUndefined();
    const roles = provider.calls[1]?.request.messages.map((message) => message.role) ?? [];
    // At least the minimum turns, never the whole history.
    expect(roles.length).toBeGreaterThanOrEqual(5);
    expect(roles.length).toBeLessThan(21);
  });
});

describe("summaries do not depend on the chat context window", () => {
  it("still accepts a summary request when the window is unknown", async () => {
    const { h } = setup();
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    setContextWindow(h, modelRef, undefined);
    const accepted = await h.summaries.create(LOCAL, contentId, { templateId: "summary.core", modelRef }, undefined);
    expect(accepted.status).toBe(202);
  });
});

describe("quiescing an owner", () => {
  it("tracks streaming answers per owner and abortOwner waits for their final state", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 3);
    const modelRef = configureChatModel(h, 128_000);
    provider.script(async function* (_request, opts): AsyncGenerator<LlmStreamEvent> {
      yield { type: "text_delta", delta: "开头" };
      await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
      yield { type: "done", stopReason: "aborted" };
    });
    const result = h.chat.send(LOCAL, contentId, { text: "q", modelRef }, undefined, never());
    expect(h.chat.hasInflight(LOCAL.userId)).toBe(true);
    expect(h.chat.hasInflight(BOB.userId)).toBe(false);
    const consumed = collect(result);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await h.chat.abortOwner(LOCAL.userId);
    expect(h.chat.hasInflight(LOCAL.userId)).toBe(false);
    expect(h.chat.get(LOCAL, contentId, {}).messages[1]).toMatchObject({ status: "interrupted", text: "开头" });
    expect(doneOf(await consumed).status).toBe("interrupted");
    // Nothing streaming: resolves at once.
    await h.chat.abortOwner(BOB.userId);
  });

  it("tracks answers per Content; abortContent aborts only that Content's and returns at once", async () => {
    const provider = new FakeLlmProvider();
    const { h } = setup(provider);
    const { contentId } = seedChatContent(h, 3);
    const other = seedChatContent(h, 3).contentId;
    const modelRef = configureChatModel(h, 128_000);
    provider.script(async function* (_request, opts): AsyncGenerator<LlmStreamEvent> {
      yield { type: "text_delta", delta: "开头" };
      await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
      yield { type: "done", stopReason: "aborted" };
    });
    const result = h.chat.send(LOCAL, contentId, { text: "q", modelRef }, undefined, never());
    expect(h.chat.hasInflightFor(LOCAL.userId, contentId)).toBe(true);
    expect(h.chat.hasInflightFor(LOCAL.userId, other)).toBe(false);
    expect(h.chat.hasInflightFor(BOB.userId, contentId)).toBe(false);
    const consumed = collect(result);
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.chat.abortContent(LOCAL.userId, other);
    h.chat.abortContent(BOB.userId, contentId);
    expect(h.chat.hasInflightFor(LOCAL.userId, contentId)).toBe(true);
    // No await: the abort is only signalled.
    h.chat.abortContent(LOCAL.userId, contentId);
    expect(doneOf(await consumed).status).toBe("interrupted");
    expect(h.chat.hasInflightFor(LOCAL.userId, contentId)).toBe(false);
  });
});
