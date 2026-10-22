import type { Page, Request, Route } from "@playwright/test";
import { chatDtoSchema, chatMessageDtoSchema, chatMessageRequestSchema, chatStreamEventSchemas, type ChatMessageDto, type ChatStreamEventType } from "../../src/shared/dto/chat.ts";
import { providerListDtoSchema } from "../../src/shared/dto/provider.ts";
import { BILI_REVISION, BILIBILI_CONTENT, CITED_INDEX, CITED_START_MS, PROFILE, providerProfile, REVISION, segmentId } from "./mock-backend.ts";

/**
 * The fake chat of the browser smoke: one thread per Content kept per page, answers
 * streamed as a single SSE body whose events are parsed with the shared schemas, and a
 * switch that makes a Content's model report an unknown context window until an override
 * is saved.
 */

interface ChatState {
  threads: Map<string, ChatMessageDto[]>;
  unknownWindow: Set<string>;
  /** Contents answered in the metadata mode, as if they had no transcript yet. */
  noTranscript: Set<string>;
  next: number;
}

const states = new WeakMap<Page, ChatState>();

function stateOf(page: Page): ChatState {
  let state = states.get(page);
  if (state === undefined) {
    state = { threads: new Map(), unknownWindow: new Set(), noTranscript: new Set(), next: 0 };
    states.set(page, state);
  }
  return state;
}

/** Makes `GET chat` of this Content report `context_window_unknown` until the Profile is saved with a context window. */
export function setContextWindowUnknown(page: Page, contentId: string): void {
  stateOf(page).unknownWindow.add(contentId);
}

/** Makes this Content's chat run in the metadata mode (no transcript yet). */
export function setNoTranscript(page: Page, contentId: string): void {
  stateOf(page).noTranscript.add(contentId);
}

/** The metadata-mode answer: it says it is not grounded and cites nothing. */
export const CHAT_METADATA_ANSWER = "字幕尚未就绪，以下回答未依据视频原文。";

/** The answer every question gets; it cites the sentence the summary cites too. */
export const CHAT_ANSWER_PREFIX = "这一讲的重点在第八句";
export const CHAT_SUGGESTIONS = ["第八句具体讲了什么？", "还有哪些例子？"];

const revisionOf = (contentId: string): string => (contentId === BILIBILI_CONTENT ? BILI_REVISION : REVISION);

function sse<T extends ChatStreamEventType>(type: T, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(chatStreamEventSchemas[type].parse(data))}\n\n`;
}

/** `/api/contents/:id/chat*` and the Profile reads / saves of the unknown-context-window switch; false for anything else. */
export async function handleChat(route: Route, request: Request, url: URL): Promise<boolean> {
  const method = request.method();
  const path = url.pathname;
  const page = request.frame().page();
  const state = stateOf(page);

  // While a window is unknown the Profile lists its model without one; saving the Profile
  // editor (PATCH with the model's context window) is the user filling it in.
  if (state.unknownWindow.size > 0 && method === "GET" && path === "/api/providers") {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(providerListDtoSchema.parse({ items: [providerProfile(undefined)] })) });
    return true;
  }
  if (method === "PATCH" && path === `/api/providers/${PROFILE}`) {
    const window = (request.postDataJSON() as { models?: Array<{ contextWindowTokens?: number }> }).models?.[0]?.contextWindowTokens;
    if (window !== undefined && window > 0) {
      state.unknownWindow.clear();
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(providerProfile(window)) });
    return true;
  }

  const match = /^\/api\/contents\/([^/]+)\/chat(\/messages)?$/.exec(path);
  if (match === null) {
    return false;
  }
  const contentId = match[1] as string;
  const messages = state.threads.get(contentId) ?? [];

  if (method === "GET" && match[2] === undefined) {
    const context = state.unknownWindow.has(contentId)
      ? { mode: "unavailable", reason: "context_window_unknown" }
      : state.noTranscript.has(contentId)
        ? { mode: "metadata", estimatedTokens: 321 }
        : { mode: "full", estimatedTokens: 4321 };
    const body = chatDtoSchema.parse({ thread: messages.length === 0 ? null : { id: `thread-${contentId}` }, messages, context });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    return true;
  }

  if (method === "DELETE" && match[2] === undefined) {
    state.threads.delete(contentId);
    await route.fulfill({ status: 204, body: "" });
    return true;
  }

  if (method === "POST" && match[2] !== undefined) {
    const request_ = chatMessageRequestSchema.parse(request.postDataJSON());
    if (state.noTranscript.has(contentId)) {
      const ids = { user: `01J00000000000000000MSG${String(++state.next).padStart(3, "0")}`, answer: `01J00000000000000000MSG${String(++state.next).padStart(3, "0")}` };
      const user = chatMessageDtoSchema.parse({ id: ids.user, role: "user", text: request_.text, status: "complete", citations: [], createdAt: state.next });
      const answer = chatMessageDtoSchema.parse({ id: ids.answer, role: "assistant", text: CHAT_METADATA_ANSWER, status: "complete", citations: [], createdAt: state.next + 1 });
      state.threads.set(contentId, [...messages, user, answer]);
      const body = [sse("answer.delta", { delta: CHAT_METADATA_ANSWER }), sse("done", { userMessageId: ids.user, messageId: ids.answer, status: "complete" })].join("");
      await route.fulfill({ status: 200, contentType: "text/event-stream", body });
      return true;
    }
    const revision = revisionOf(contentId);
    const cited = segmentId(revision, CITED_INDEX);
    const ids = { user: `01J00000000000000000MSG${String(++state.next).padStart(3, "0")}`, answer: `01J00000000000000000MSG${String(++state.next).padStart(3, "0")}` };
    const deltas = [`${CHAT_ANSWER_PREFIX} `, `[[seg:${cited}]]`, "。"];
    const user = chatMessageDtoSchema.parse({
      id: ids.user,
      role: "user",
      text: request_.text,
      status: "complete",
      citations: request_.quote === undefined ? [] : [request_.quote],
      ...(request_.quote === undefined ? {} : { quote: request_.quote }),
      createdAt: state.next,
    });
    const answer = chatMessageDtoSchema.parse({
      id: ids.answer,
      role: "assistant",
      text: deltas.join(""),
      status: "complete",
      contextTranscriptRevisionId: revision,
      citations: [{ transcriptRevisionId: revision, segmentId: cited }],
      suggestions: CHAT_SUGGESTIONS,
      createdAt: state.next + 1,
    });
    state.threads.set(contentId, [...messages, user, answer]);
    const body = [
      sse("answer.delta", { delta: deltas[0] }),
      sse("citation", { transcriptRevisionId: revision, segmentId: cited, startMs: CITED_START_MS }),
      sse("answer.delta", { delta: deltas[1] }),
      sse("answer.delta", { delta: deltas[2] }),
      sse("suggestions", { items: CHAT_SUGGESTIONS }),
      sse("usage", { inputTokens: 1200, outputTokens: 40 }),
      sse("done", { userMessageId: ids.user, messageId: ids.answer, status: "complete" }),
    ].join("");
    await route.fulfill({ status: 200, contentType: "text/event-stream", body });
    return true;
  }
  return false;
}
