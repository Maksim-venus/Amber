import { monotonicFactory } from "ulid";
import { CHAT_RETRIEVAL_HITS_MAX } from "../../shared/defaults.ts";
import type { ChatContextDto, ChatDto, ChatMessageDto, ChatMessageRequest, ChatQuery, ChatStreamEvent } from "../../shared/dto/chat.ts";
import type { AppError } from "../../shared/errors.ts";
import type { ChatMessage, ChatThread } from "../domain/chat.ts";
import {
  chooseChatMode,
  citationAliasTable,
  citedSegmentIds,
  compactionPrompt,
  planChatRequest,
  turnsToCompact,
  type ChatMetadata,
  type ChatPlanInput,
  type ChatQuoteText,
  type ChatRequestPlan,
  type ChatTurnText,
} from "../domain/chat-context.ts";
import { ChatStreamAssembler, type ChatAnswer } from "../domain/chat-stream.ts";
import { finalizeCitations } from "../domain/citations.ts";
import { displayTitle, type Content } from "../domain/content.ts";
import { amberError, appError } from "../domain/errors.ts";
import type { ModelRef, ModelRefSnapshot } from "../domain/model-ref.ts";
import { CHAT_COMPACTION_PROMPT, DEFAULT_SUMMARY_TEMPLATE_ID } from "../domain/prompts.ts";
import { effectiveCapability } from "../domain/provider-profile.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import { toAppError } from "../pipeline/retry.ts";
import type { Logger } from "../ports/logger.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import { jsonRequestDigest } from "./idempotency.ts";
import type { LlmGateway } from "./llm-gateway.ts";
import { defaultSettings, defaultSummaryTemplateIdOf, outputLanguageFor } from "./settings.ts";

export const CHAT_ROUTE = "POST /api/contents/:id/chat/messages";

export interface ChatServiceOptions {
  repository: Repository;
  llm: LlmGateway;
  logger: Logger;
  newId?: () => string;
  now?: () => number;
}

/** A POST either replays a stored answer or streams a new one. */
export type ChatSendResult = { kind: "replay"; message: ChatMessageDto } | { kind: "stream"; events: AsyncIterable<ChatStreamEvent> };

/** An answer streaming in this process; `done` settles once its final state is stored. */
interface InflightAnswer {
  contentId: string;
  controller: AbortController;
  done: Promise<void>;
}

/** Everything about a thread a request plans with, read in one transaction. */
interface ThreadState {
  content: Content;
  /** Absent while the Content has no transcript: the metadata mode. */
  primaryRevisionId: string | undefined;
  input: Omit<ChatPlanInput, "contextWindowTokens" | "question" | "quote" | "positionMs">;
  thread: ChatThread | undefined;
  /** Uncompacted turns with the id of their last message. */
  turns: Array<ChatTurnText & { lastMessageId: string }>;
  startMs: Map<string, number>;
}

/**
 * One persistent conversation per Content. Answers stream from the LlmGateway
 * (which holds the LLM slot and records usage); every message is stored before the call so
 * a half-streamed answer is never mistaken for a complete one. Compaction folds older turns
 * only when the request does not fit; its failure never blocks the answer.
 */
export class ChatService {
  private readonly options: ChatServiceOptions;
  private readonly newId: () => string;
  private readonly now: () => number;
  /** Streaming answers per owner, so an account can be quiesced before deletion. */
  private readonly inflight = new Map<string, Set<InflightAnswer>>();

  constructor(options: ChatServiceOptions) {
    this.options = options;
    this.newId = options.newId ?? monotonicFactory();
    this.now = options.now ?? Date.now;
  }

  get(principal: RequestPrincipal, contentId: string, query: ChatQuery): ChatDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const content = this.requireContent(scope, owner, contentId);
      const thread = scope.chat.getThread(owner, contentId);
      const messages = thread === undefined ? [] : scope.chat.listMessages(owner, thread.id);
      return {
        thread: thread === undefined ? null : { id: thread.id, ...(thread.currentCompactionId === undefined ? {} : { currentCompactionId: thread.currentCompactionId }) },
        messages: messages.map(messageDto),
        context: this.context(scope, owner, content, query),
      };
    });
  }

  /**
   * Validates and stores the question, then returns the answer stream. Every refusal
   * (unknown content, foreign quote, unusable model, unknown context window,
   * a fixed part beyond the budget) is thrown here, before anything streams.
   */
  send(principal: RequestPrincipal, contentId: string, body: ChatMessageRequest, idempotencyKey: string | undefined, signal: AbortSignal): ChatSendResult {
    const owner = principal.userId;
    const digest = jsonRequestDigest({ contentId, ...body });
    const replay = this.options.repository.withTransaction((scope) => {
      this.requireContent(scope, owner, contentId);
      if (idempotencyKey === undefined) {
        return undefined;
      }
      const stored = scope.idempotency.get(owner, CHAT_ROUTE, idempotencyKey);
      if (stored === undefined) {
        return undefined;
      }
      if (stored.requestDigest !== digest) {
        throw amberError("idempotency_conflict", "idempotency key reused with a different request");
      }
      const [, assistantId] = JSON.parse(stored.resourceRefsJson) as string[];
      const message = assistantId === undefined ? undefined : scope.chat.getMessage(owner, assistantId);
      if (message === undefined) {
        throw amberError("not_found", "the replayed answer no longer exists");
      }
      return messageDto(message);
    });
    if (replay !== undefined) {
      return { kind: "replay", message: replay };
    }

    const description = this.options.llm.describe(owner, body.modelRef);
    const contextWindowTokens = description.capability.limits.contextWindowTokens;
    if (contextWindowTokens === undefined) {
      throw contextWindowUnknown(body.modelRef);
    }
    const prepared = this.options.repository.withTransaction((scope) => {
      const state = this.state(scope, owner, contentId);
      const quote = body.quote === undefined ? undefined : this.quoteText(scope, owner, contentId, body.quote);
      const input: ChatPlanInput = {
        ...state.input,
        contextWindowTokens,
        turns: state.turns,
        question: body.text,
        ...(quote === undefined ? {} : { quote }),
        ...(body.positionMs === undefined ? {} : { positionMs: body.positionMs }),
      };
      const hits =
        chooseChatMode(input) === "retrieval" && state.primaryRevisionId !== undefined
          ? scope.search.matchSegments(owner, state.primaryRevisionId, [quote?.text ?? "", body.text].join(" ").trim(), CHAT_RETRIEVAL_HITS_MAX)
          : [];
      const plan = planChatRequest(input, hits);

      const now = this.now();
      const thread = state.thread ?? { id: this.newId(), contentId };
      if (state.thread === undefined) {
        scope.chat.insertThread(owner, thread);
      }
      const userMessage: ChatMessage = {
        id: this.newId(),
        threadId: thread.id,
        role: "user",
        text: body.text,
        status: "complete",
        citations: body.quote === undefined ? [] : [{ transcriptRevisionId: body.quote.transcriptRevisionId, segmentId: body.quote.segmentId }],
        createdAt: now,
      };
      const assistantMessage: ChatMessage = {
        id: this.newId(),
        threadId: thread.id,
        role: "assistant",
        text: "",
        status: "streaming",
        modelRef: description.snapshot,
        ...(state.primaryRevisionId === undefined ? {} : { contextTranscriptRevisionId: state.primaryRevisionId }),
        citations: [],
        createdAt: now,
      };
      scope.chat.insertMessage(owner, userMessage);
      scope.chat.insertMessage(owner, assistantMessage);
      const settings = scope.userSettings.get(owner) ?? defaultSettings(owner, now);
      scope.userSettings.put({ ...settings, chatModelRef: { providerProfileId: body.modelRef.providerProfileId, modelId: body.modelRef.modelId }, updatedAt: now });
      if (idempotencyKey !== undefined) {
        scope.idempotency.insert({
          userId: owner,
          route: CHAT_ROUTE,
          key: idempotencyKey,
          requestDigest: digest,
          responseStatus: 200,
          responseBodyJson: JSON.stringify({ messageId: assistantMessage.id }),
          resourceRefsJson: JSON.stringify([userMessage.id, assistantMessage.id]),
          createdAt: now,
        });
      }
      return { state, input, plan, thread, userMessageId: userMessage.id, assistantMessageId: assistantMessage.id };
    });
    // Registered in the same synchronous step as the commit above, so no check can fall
    // between the stored `streaming` message and its registration.
    const controller = new AbortController();
    const forward = (): void => controller.abort(signal.reason);
    if (signal.aborted) {
      forward();
    } else {
      signal.addEventListener("abort", forward, { once: true });
    }
    let settle = (): void => undefined;
    const entry: InflightAnswer = { contentId, controller, done: new Promise<void>((resolve) => (settle = resolve)) };
    const entries = this.inflight.get(owner) ?? new Set<InflightAnswer>();
    entries.add(entry);
    this.inflight.set(owner, entries);
    const release = (): void => {
      signal.removeEventListener("abort", forward);
      entries.delete(entry);
      if (entries.size === 0 && this.inflight.get(owner) === entries) {
        this.inflight.delete(owner);
      }
      settle();
    };
    return { kind: "stream", events: tracked(this.answer(owner, body.modelRef, description.snapshot, prepared, controller.signal), release) };
  }

  /** Whether any answer of the owner is still streaming in this process. */
  hasInflight(ownerUserId: string): boolean {
    return (this.inflight.get(ownerUserId)?.size ?? 0) > 0;
  }

  /** Whether any answer of any owner is still streaming in this process; backups and updates wait for none. */
  hasAnyInflight(): boolean {
    return [...this.inflight.values()].some((entries) => entries.size > 0);
  }

  /** Whether an answer about this Content is still streaming in this process; a purge waits for it. */
  hasInflightFor(ownerUserId: string, contentId: string): boolean {
    return [...(this.inflight.get(ownerUserId) ?? [])].some((entry) => entry.contentId === contentId);
  }

  /**
   * Aborts the answers streaming about a Content that went to the trash. It does not wait:
   * each answer stores its `interrupted` state once its stream is next read, which may be
   * never for a client that went away, and moving to the trash must not hang on that.
   */
  abortContent(ownerUserId: string, contentId: string): void {
    for (const entry of this.inflight.get(ownerUserId) ?? []) {
      if (entry.contentId === contentId) {
        entry.controller.abort(new Error("content moved to the trash"));
      }
    }
  }

  /**
   * Aborts every answer the owner has streaming and resolves once each has stored its
   * final (`interrupted`) state; used before the account is deleted.
   */
  async abortOwner(ownerUserId: string): Promise<void> {
    const entries = [...(this.inflight.get(ownerUserId) ?? [])];
    for (const entry of entries) {
      entry.controller.abort(new Error("account is being deleted"));
    }
    await Promise.allSettled(entries.map((entry) => entry.done));
  }

  /** `DELETE /api/contents/:id/chat`: the history goes, usage rows stay. */
  clear(principal: RequestPrincipal, contentId: string): void {
    const owner = principal.userId;
    this.options.repository.withTransaction((scope) => {
      this.requireContent(scope, owner, contentId);
      scope.chat.deleteThread(owner, contentId);
    });
  }

  /** Start-up: answers a previous process left `streaming` become `interrupted`. */
  recoverInterrupted(): number {
    return this.options.repository.withTransaction((scope) => scope.chat.interruptStreaming());
  }

  private async *answer(
    owner: string,
    modelRef: ModelRef,
    snapshot: ModelRefSnapshot,
    prepared: { state: ThreadState; input: ChatPlanInput; plan: ChatRequestPlan; thread: ChatThread; userMessageId: string; assistantMessageId: string },
    signal: AbortSignal,
  ): AsyncGenerator<ChatStreamEvent> {
    const { state, userMessageId, assistantMessageId } = prepared;
    let plan = prepared.plan;
    let status: ChatMessage["status"] = "failed";
    let error: AppError | undefined;
    let assembler: ChatStreamAssembler | undefined;
    let answer: ChatAnswer = { text: "", citations: [] };
    let stop: string | undefined;
    try {
      if (plan.overBudget) {
        plan = (await this.compact(owner, modelRef, snapshot, prepared, signal)) ?? plan;
      }
      assembler = new ChatStreamAssembler(plan.table, (segmentId) => state.startMs.get(segmentId) ?? 0);
      const stream = this.options.llm.stream(
        { userId: owner, feature: "chat", contentId: state.content.id, chatMessageId: assistantMessageId },
        { modelRef, system: plan.system, messages: plan.messages },
        { signal },
      );
      for await (const event of stream) {
        if (signal.aborted) {
          break;
        }
        if (event.type === "text_delta") {
          yield* assembler.push(event.delta).map(toStreamEvent);
        } else if (event.type === "usage") {
          yield { type: "usage", data: { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens } };
        } else {
          stop = event.stopReason;
          if (event.stopReason === "error") {
            error = appError("llm_failed", event.raw === undefined ? {} : { upstreamMessage: event.raw });
          } else if (event.stopReason === "refused") {
            error = appError("llm_failed", { code: "llm_failed.refused", ...(event.raw === undefined ? {} : { upstreamMessage: event.raw }) });
          }
        }
      }
      if (signal.aborted || stop === "aborted") {
        status = "interrupted";
      } else if (error === undefined) {
        status = "complete";
        const finished = assembler.finish();
        answer = finished.answer;
        yield* finished.events.map(toStreamEvent);
        if (answer.suggestions !== undefined) {
          yield { type: "suggestions", data: { items: answer.suggestions } };
        }
      }
    } catch (thrown) {
      if (signal.aborted) {
        status = "interrupted";
      } else {
        status = "failed";
        error = toAppError(thrown);
      }
    }
    // A refused answer is incomplete by definition: none of it is kept.
    if (status !== "complete" && assembler !== undefined && stop !== "refused") {
      answer = assembler.partial();
    }
    try {
      this.options.repository.withTransaction((scope) =>
        scope.chat.finishMessage(owner, {
          id: assistantMessageId,
          text: answer.text,
          status,
          citations: answer.citations,
          ...(answer.suggestions === undefined ? {} : { suggestions: answer.suggestions }),
        }),
      );
    } catch (thrown) {
      // The thread may have been cleared or the Content deleted while the answer streamed.
      this.options.logger.warn("chat_answer_not_stored", { code: toAppError(thrown).code });
    }
    yield { type: "done", data: { userMessageId, messageId: assistantMessageId, status, ...(error === undefined ? {} : { error }) } };
  }

  /**
   * Folds every uncompacted turn but the most recent `CHAT_RECENT_TURNS` into a new
   * compaction (the `chat.compaction` prompt) and plans again with it. Returns undefined
   * when there is nothing to fold or the call fails; the caller then goes on with the turns
   * that fit.
   */
  private async compact(
    owner: string,
    modelRef: ModelRef,
    snapshot: ModelRefSnapshot,
    prepared: { state: ThreadState; input: ChatPlanInput; thread: ChatThread },
    signal: AbortSignal,
  ): Promise<ChatRequestPlan | undefined> {
    const { state, input, thread } = prepared;
    const older = turnsToCompact(state.turns);
    const last = older.at(-1);
    if (last === undefined) {
      return undefined;
    }
    try {
      const cited = citedSegmentIds([input.compaction ?? "", ...older.map((turn) => turn.answer)]);
      const sentences = this.options.repository.withTransaction((scope) =>
        cited.flatMap((segmentId) => {
          const segment = scope.transcripts.getSegment(owner, segmentId);
          return segment === undefined ? [] : [{ transcriptRevisionId: segment.revisionId, segmentId, text: segment.text }];
        }),
      );
      const table = citationAliasTable(sentences);
      const prompt = compactionPrompt({ ...(input.compaction === undefined ? {} : { compaction: input.compaction }), turns: older, outputLanguage: input.outputLanguage }, table);
      const completion = await this.options.llm.complete(
        { userId: owner, feature: "chat_compaction", contentId: state.content.id },
        { modelRef, system: "", messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] },
        { signal },
      );
      const body = finalizeCitations(completion.text.trim(), table).body;
      this.options.repository.withTransaction((scope) => {
        const id = this.newId();
        scope.chat.insertCompaction(owner, {
          id,
          threadId: thread.id,
          throughMessageId: last.lastMessageId,
          body,
          modelRef: snapshot,
          promptRef: { ...CHAT_COMPACTION_PROMPT.ref },
          promptSnapshot: prompt,
          createdAt: this.now(),
        });
        scope.tokenUsage.attach(owner, [completion.invocationId], id);
      });
      const remaining = state.turns.slice(older.length);
      return planChatRequest({ ...input, compaction: body, turns: remaining }, this.hitsFor(owner, state, input));
    } catch (thrown) {
      if (signal.aborted) {
        throw thrown;
      }
      this.options.logger.warn("chat_compaction_failed", { code: toAppError(thrown).code });
      return undefined;
    }
  }

  private hitsFor(owner: string, state: ThreadState, input: ChatPlanInput): string[] {
    if (chooseChatMode(input) !== "retrieval" || state.primaryRevisionId === undefined) {
      return [];
    }
    const question = [input.quote?.text ?? "", input.question].join(" ").trim();
    const revisionId = state.primaryRevisionId;
    return this.options.repository.withTransaction((scope) => scope.search.matchSegments(owner, revisionId, question, CHAT_RETRIEVAL_HITS_MAX));
  }

  /** `context` of `GET chat`: the chosen model's mode and estimate for an empty question. */
  private context(scope: RepositoryScope, owner: string, content: Content, query: ChatQuery): ChatContextDto {
    const settings = scope.userSettings.get(owner);
    const modelRef: ModelRef | undefined =
      query.providerProfileId !== undefined && query.modelId !== undefined
        ? { providerProfileId: query.providerProfileId, modelId: query.modelId }
        : (settings?.chatModelRef ?? settings?.defaultModelRef);
    const model = modelRef === undefined ? undefined : scope.providerProfiles.get(owner, modelRef.providerProfileId)?.models.find((candidate) => candidate.modelId === modelRef.modelId);
    if (model === undefined) {
      return { mode: "unavailable", reason: "no_model" };
    }
    const contextWindowTokens = effectiveCapability(model).limits.contextWindowTokens;
    if (contextWindowTokens === undefined) {
      return { mode: "unavailable", reason: "context_window_unknown" };
    }
    const state = this.state(scope, owner, content.id);
    const input: ChatPlanInput = { ...state.input, contextWindowTokens, turns: state.turns, question: "" };
    try {
      const plan = planChatRequest(input);
      return { mode: plan.mode, estimatedTokens: plan.estimatedTokens };
    } catch {
      return { mode: chooseChatMode(input) };
    }
  }

  private requireContent(scope: RepositoryScope, owner: string, contentId: string): Content {
    const content = scope.contents.get(owner, contentId);
    if (content === undefined) {
      throw amberError("not_found", "content not found for this owner");
    }
    return content;
  }

  private state(scope: RepositoryScope, owner: string, contentId: string): ThreadState {
    const content = this.requireContent(scope, owner, contentId);
    const primaryRevisionId = content.primaryTranscriptRevisionId;
    const segments = primaryRevisionId === undefined ? [] : scope.transcripts.listSegments(owner, primaryRevisionId);
    const templateId = defaultSummaryTemplateIdOf(scope, owner) ?? DEFAULT_SUMMARY_TEMPLATE_ID;
    const artifact = scope.summaries.findArtifact(owner, contentId, templateId);
    const summary = artifact?.currentRevisionId === undefined ? undefined : scope.summaries.getRevision(owner, artifact.currentRevisionId)?.body;
    const chapters = (scope.chapters.getCurrent(owner, contentId)?.chapters ?? []).map(({ startMs, endMs, title }) => ({ startMs, endMs, title }));
    const thread = scope.chat.getThread(owner, contentId);
    const compaction = thread?.currentCompactionId === undefined ? undefined : scope.chat.getCompaction(owner, thread.currentCompactionId);
    const messages = thread === undefined ? [] : scope.chat.listMessages(owner, thread.id);
    const after = compaction === undefined ? 0 : messages.findIndex((message) => message.id === compaction.throughMessageId) + 1;
    return {
      content,
      primaryRevisionId,
      input: {
        outputLanguage: outputLanguageFor(scope, owner, undefined),
        ...(primaryRevisionId === undefined ? { metadata: metadataOf(content, scope.referenceTexts.listByContent(owner, contentId).map((reference) => reference.text)) } : { revisionId: primaryRevisionId }),
        segments,
        ...(summary === undefined ? {} : { summary }),
        chapters,
        ...(compaction === undefined ? {} : { compaction: compaction.body }),
        turns: [],
      },
      thread,
      turns: turnsOf(messages.slice(after), (segmentId) => scope.transcripts.getSegment(owner, segmentId)?.text),
      startMs: new Map(segments.map((segment) => [segment.id as string, segment.startMs])),
    };
  }

  /** The quoted sentence, which must belong to a revision of this Content; its text comes from the store. */
  private quoteText(scope: RepositoryScope, owner: string, contentId: string, quote: { transcriptRevisionId: string; segmentId: string }): ChatQuoteText {
    const revision = scope.transcripts.getRevision(owner, quote.transcriptRevisionId);
    const segment = scope.transcripts.getSegment(owner, quote.segmentId);
    if (revision === undefined || revision.contentId !== contentId || segment === undefined || segment.revisionId !== revision.id) {
      throw amberError("invalid_request", "the quoted sentence is not part of this content", { params: { detail: "body.quote" } });
    }
    return { segmentId: segment.id, text: segment.text };
  }
}

/**
 * Pairs each user message with the answer that follows it. A turn whose answer is still
 * streaming (another request in flight) is left out; a failed answer counts as empty.
 */
function turnsOf(messages: readonly ChatMessage[], textOf: (segmentId: string) => string | undefined): Array<ChatTurnText & { lastMessageId: string }> {
  const turns: Array<ChatTurnText & { lastMessageId: string }> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const user = messages[index] as ChatMessage;
    if (user.role !== "user") {
      continue;
    }
    const next = messages[index + 1];
    const assistant = next?.role === "assistant" ? next : undefined;
    if (assistant?.status === "streaming") {
      continue;
    }
    const quoted = user.citations[0];
    const quoteText = quoted === undefined ? undefined : textOf(quoted.segmentId);
    turns.push({
      question: user.text,
      ...(quoted === undefined || quoteText === undefined ? {} : { quote: { segmentId: quoted.segmentId, text: quoteText } }),
      answer: assistant === undefined || assistant.status === "failed" ? "" : assistant.text,
      lastMessageId: (assistant ?? user).id,
    });
  }
  return turns;
}

/** What the metadata mode (the `chat.system.metadata` prompt) tells the model about a Content without a transcript. */
function metadataOf(content: Content, references: string[]): ChatMetadata {
  const title = displayTitle(content);
  return {
    source: content.source.kind,
    references,
    ...(title === undefined ? {} : { title }),
    ...(content.source.channelTitle === undefined ? {} : { channelTitle: content.source.channelTitle }),
    ...(content.durationMs === undefined ? {} : { durationMs: content.durationMs }),
    ...(content.publishedAt === undefined ? {} : { publishedAt: content.publishedAt }),
  };
}

function messageDto(message: ChatMessage): ChatMessageDto {
  const quote = message.role === "user" ? message.citations[0] : undefined;
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    status: message.status,
    ...(message.modelRef === undefined ? {} : { modelRef: { ...message.modelRef } }),
    ...(message.contextTranscriptRevisionId === undefined ? {} : { contextTranscriptRevisionId: message.contextTranscriptRevisionId }),
    citations: message.role === "user" ? [] : message.citations.map((citation) => ({ ...citation })),
    ...(message.suggestions === undefined ? {} : { suggestions: [...message.suggestions] }),
    ...(quote === undefined ? {} : { quote: { ...quote } }),
    createdAt: message.createdAt,
  };
}

function toStreamEvent(event: ReturnType<ChatStreamAssembler["push"]>[number]): ChatStreamEvent {
  return event.type === "answer.delta"
    ? { type: "answer.delta", data: { delta: event.delta } }
    : { type: "citation", data: { ...event.citation, startMs: event.startMs } };
}

function contextWindowUnknown(modelRef: ModelRef) {
  return amberError("llm_capability", "the chat model has no context window", {
    code: "llm_capability.context_window_unknown",
    details: { providerProfileId: modelRef.providerProfileId, modelId: modelRef.modelId },
  });
}

/** Passes the events through and calls `release` once the stream ends, however it ends. */
async function* tracked<T>(events: AsyncIterable<T>, release: () => void): AsyncGenerator<T> {
  try {
    yield* events;
  } finally {
    release();
  }
}
