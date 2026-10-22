import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ChatDto, ChatMessageDto } from "../../../src/shared/dto/chat.ts";
import { ChatComposer, ChatComposerProvider } from "../../../src/web/chat/chat-composer.tsx";
import { ChatPanel } from "../../../src/web/chat/chat-panel.tsx";
import { SelectionToolbar } from "../../../src/web/chat/selection-toolbar.tsx";
import { ContentPageProvider, type ContentPageState } from "../../../src/web/pages/content/content-context.tsx";
import { PlayerController, PlayerControllerProvider } from "../../../src/web/player/player-controller.tsx";
import { ContextMenuHost } from "../../../src/web/ui/context-menu.tsx";
import { CITED_SEGMENT_ID, contentDetail, revision, SEGMENTS } from "../../fixtures/web/content-data.ts";
import { mockApi, renderApp, type RecordedCall } from "../../fixtures/web/render.tsx";
import { provider } from "../../fixtures/web/shell-data.ts";

const MODEL = { providerProfileId: "p1", modelId: "m-chat" };
const PROVIDERS = { items: [provider("p1", "Relay", ["m-default", "m-chat"])] };
const SETTINGS = { theme: "light", language: "zh-CN", shortcuts: {}, chatModelRef: MODEL, defaultModelRef: { providerProfileId: "p1", modelId: "m-default" }, updatedAt: 1 };

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function stream(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of frames) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** Messages are written loosely; segment ids in fixtures are plain strings. */
function chatOf(messages: Array<Record<string, unknown>> = [], context: ChatDto["context"] = { mode: "full", estimatedTokens: 12_345 }): ChatDto {
  return { thread: messages.length === 0 ? null : { id: "th1" }, messages: messages as unknown as ChatMessageDto[], context };
}

/** Routes for the panel plus a POST handler; returns every call, the POST included. */
function api(options: { chat?: (call: RecordedCall) => ChatDto; post?: (call: RecordedCall) => Response; providers?: unknown } = {}) {
  const { calls } = mockApi({
    "GET /api/providers": { body: options.providers ?? PROVIDERS },
    "GET /api/settings": { body: SETTINGS },
    "GET /api/contents/c1/chat": (call) => ({ body: (options.chat ?? (() => chatOf()))(call) }),
    "GET /api/transcript/revisions/r1/segments": { body: { revision: revision("r1"), items: SEGMENTS } },
  });
  const base = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    if ((init.method ?? "GET") === "POST" && String(input).endsWith("/chat/messages")) {
      const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      const call: RecordedCall & { signal?: AbortSignal } = { method: "POST", path: String(input), headers, body: JSON.parse(String(init.body)), ...(init.signal == null ? {} : { signal: init.signal }) };
      calls.push(call);
      return options.post === undefined ? stream([]) : options.post(call);
    }
    return base(input, init);
  });
  return calls;
}

function Page(props: { children: ReactNode; select?: ContentPageState["select"]; openTab?: ContentPageState["openTab"] }) {
  const [controller] = useState(() => new PlayerController());
  const [composer] = useState(() => new ChatComposer());
  const state: ContentPageState = {
    content: contentDetail(),
    primaryRevisionId: "r1",
    selection: undefined,
    select: props.select ?? (() => undefined),
    openTab: props.openTab ?? (() => undefined),
    highlightThreshold: 80,
    setHighlightThreshold: () => undefined,
    openSubtitleEditor: () => undefined,
  };
  return (
    <PlayerControllerProvider controller={controller}>
      <ContentPageProvider value={state}>
        <ChatComposerProvider composer={composer}>{props.children}</ChatComposerProvider>
      </ContentPageProvider>
    </PlayerControllerProvider>
  );
}

const input = () => screen.getByTestId("chat-input") as HTMLTextAreaElement;

describe("ChatPanel", () => {
  it("streams an answer with a clickable citation and suggestions, then reads the stored thread", async () => {
    let stored = false;
    const answer = `先看重排序 [[seg:${CITED_SEGMENT_ID}]]。`;
    const calls = api({
      chat: () =>
        stored
          ? chatOf([
              { id: "m1", role: "user", text: "讲了什么？", status: "complete", citations: [], createdAt: 1 },
              {
                id: "m2",
                role: "assistant",
                text: answer,
                status: "complete",
                contextTranscriptRevisionId: "r1",
                citations: [{ transcriptRevisionId: "r1", segmentId: CITED_SEGMENT_ID }],
                suggestions: ["为什么要重排序？"],
                createdAt: 2,
              },
            ])
          : chatOf(),
      post: () => {
        stored = true;
        return stream([
          frame("answer.delta", { delta: "先看重排序 " }),
          frame("citation", { transcriptRevisionId: "r1", segmentId: CITED_SEGMENT_ID, startMs: 75_000 }),
          frame("answer.delta", { delta: `[[seg:${CITED_SEGMENT_ID}]]。` }),
          frame("suggestions", { items: ["为什么要重排序？"] }),
          frame("done", { userMessageId: "m1", messageId: "m2", status: "complete" }),
        ]);
      },
    });
    const select = vi.fn();
    const openTab = vi.fn();
    renderApp(
      <Page select={select} openTab={openTab}>
        <ChatPanel fill={false} />
      </Page>,
    );
    const mode = await screen.findByTestId("chat-mode");
    expect(mode.getAttribute("data-mode")).toBe("full");
    expect(mode.getAttribute("title")).toContain("12,345");
    expect((screen.getByTestId("chat-model") as HTMLSelectElement).value).toBe("p1\u0000m-chat");
    expect(calls.some((call) => call.path === "/api/contents/c1/chat?providerProfileId=p1&modelId=m-chat")).toBe(true);

    fireEvent.change(input(), { target: { value: "讲了什么？" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    const citation = await waitFor(() => {
      const button = screen.getByTestId("chat-messages").querySelector(`[data-citation='${CITED_SEGMENT_ID}']`);
      expect(button?.textContent).toBe("1:15");
      return button as HTMLElement;
    });
    const post = calls.find((call) => call.method === "POST");
    expect(post?.body).toEqual({ text: "讲了什么？", modelRef: MODEL });
    expect(post?.headers["idempotency-key"]).toBeTruthy();
    expect(post?.headers["accept"]).toBe("text/event-stream");
    expect(await screen.findByTestId("chat-suggestion")).toBeTruthy();

    fireEvent.click(citation);
    expect(select).toHaveBeenCalledWith({ revisionId: "r1", segmentId: CITED_SEGMENT_ID }, 75_000);
    expect(openTab).toHaveBeenCalledWith("transcript");

    // A suggestion only fills the input.
    const posts = calls.filter((call) => call.method === "POST").length;
    fireEvent.click(screen.getByTestId("chat-suggestion"));
    expect(input().value).toBe("为什么要重排序？");
    expect(calls.filter((call) => call.method === "POST").length).toBe(posts);
  });

  it("marks an answer whose stream broke before done as interrupted, never as complete", async () => {
    let stored = false;
    api({
      // The server stores what was streamed as `interrupted` when the stream breaks.
      chat: () =>
        stored
          ? chatOf([
              { id: "m1", role: "user", text: "继续", status: "complete", citations: [], createdAt: 1 },
              { id: "m2", role: "assistant", text: "说到一半", status: "interrupted", citations: [], createdAt: 2 },
            ])
          : chatOf(),
      post: () => {
        stored = true;
        return stream([frame("answer.delta", { delta: "说到一半" })]);
      },
    });
    renderApp(
      <Page>
        <ChatPanel fill={false} />
      </Page>,
    );
    await screen.findByTestId("chat-mode");
    fireEvent.change(input(), { target: { value: "继续" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    await waitFor(() => {
      const answer = screen.getAllByTestId("chat-message").find((element) => element.getAttribute("data-role") === "assistant");
      expect(answer?.getAttribute("data-status")).toBe("interrupted");
      expect(answer?.textContent).toContain("说到一半");
    });
    expect(screen.getByTestId("chat-message-status")).toBeTruthy();
  });

  it("keeps reading the history after a stop until the server has stored the answer as interrupted", async () => {
    // The first read after the stop still finds the answer streaming: the server has not
    // seen the disconnect yet. The panel must not stay on that state.
    let reads = 0;
    const question = { id: "m1", role: "user", text: "停一下", status: "complete", citations: [], createdAt: 1 };
    api({
      chat: () => {
        reads += 1;
        if (reads === 1) return chatOf();
        return chatOf([question, { id: "m2", role: "assistant", text: "", status: reads === 2 ? "streaming" : "interrupted", citations: [], createdAt: 2 }]);
      },
      post: (call) =>
        new Response(
          new ReadableStream({
            start(controller) {
              const signal = (call as { signal?: AbortSignal }).signal;
              signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    renderApp(
      <Page>
        <ChatPanel fill={false} />
      </Page>,
    );
    await screen.findByTestId("chat-mode");
    fireEvent.change(input(), { target: { value: "停一下" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    fireEvent.click(await screen.findByTestId("chat-stop"));
    await waitFor(
      () => {
        const answer = screen.getAllByTestId("chat-message").find((element) => element.getAttribute("data-role") === "assistant");
        expect(answer?.getAttribute("data-status")).toBe("interrupted");
      },
      { timeout: 3000 },
    );
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it("lets the user ask before there is a transcript, labelling such answers as not grounded in the video", async () => {
    let stored = false;
    api({
      chat: () =>
        stored
          ? chatOf(
              [
                { id: "m1", role: "user", text: "讲什么？", status: "complete", citations: [], createdAt: 1 },
                // No contextTranscriptRevisionId: answered in the metadata mode.
                { id: "m2", role: "assistant", text: "字幕尚未就绪，以下回答未依据视频原文。", status: "complete", citations: [], createdAt: 2 },
              ],
              { mode: "metadata", estimatedTokens: 300 },
            )
          : chatOf([], { mode: "metadata", estimatedTokens: 300 }),
      post: () => {
        stored = true;
        return stream([frame("answer.delta", { delta: "字幕尚未就绪，以下回答未依据视频原文。" }), frame("done", { userMessageId: "m1", messageId: "m2", status: "complete" })]);
      },
    });
    renderApp(
      <Page>
        <ChatPanel fill={false} />
      </Page>,
    );
    expect((await screen.findByTestId("chat-mode")).getAttribute("data-mode")).toBe("metadata");
    expect(screen.getByTestId("chat-mode").textContent).toBe("基本信息");
    expect(screen.getByTestId("chat-metadata-hint")).toBeTruthy();
    expect(screen.queryByTestId("chat-unavailable")).toBeNull();
    expect(input().disabled).toBe(false);
    fireEvent.change(input(), { target: { value: "讲什么？" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    await waitFor(() => {
      const answer = screen.getAllByTestId("chat-message").find((element) => element.getAttribute("data-role") === "assistant");
      expect(answer?.getAttribute("data-status")).toBe("complete");
      expect(answer?.querySelector('[data-testid="chat-ungrounded"]')?.textContent).toBe("未依据视频原文");
    });
  });

  it("greys the input out with a way to configure when the model's context window is unknown", async () => {
    const calls = api({ chat: () => chatOf([], { mode: "unavailable", reason: "context_window_unknown" }) });
    renderApp(
      <Page>
        <ChatPanel fill={false} />
      </Page>,
    );
    const notice = await screen.findByTestId("chat-unavailable");
    expect(notice.getAttribute("data-reason")).toBe("context_window_unknown");
    expect(screen.getByTestId("chat-configure").getAttribute("href")).toBe("/settings/models");
    expect(input().disabled).toBe(true);
    expect((screen.getByTestId("chat-send") as HTMLButtonElement).disabled).toBe(true);
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("shows the same hint and gives the question back when the POST is refused with 422", async () => {
    api({
      post: () =>
        new Response(
          JSON.stringify({ error: { class: "llm_capability", code: "llm_capability.context_window_unknown", retryDisposition: "never", userMessage: "" } }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
    });
    renderApp(
      <Page>
        <ChatPanel fill={false} />
      </Page>,
    );
    await screen.findByTestId("chat-mode");
    fireEvent.change(input(), { target: { value: "能讲讲吗" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    expect((await screen.findByTestId("chat-unavailable")).getAttribute("data-reason")).toBe("context_window_unknown");
    expect(input().value).toBe("能讲讲吗");
    expect(screen.queryAllByTestId("chat-message")).toEqual([]);
  });

  it("asks to configure a model when none is usable", async () => {
    api({ providers: { items: [] }, chat: () => chatOf([], { mode: "unavailable", reason: "no_model" }) });
    renderApp(
      <Page>
        <ChatPanel fill={false} />
      </Page>,
    );
    expect((await screen.findByTestId("chat-unavailable")).getAttribute("data-reason")).toBe("no_model");
    expect(input().disabled).toBe(true);
  });

  it("folds to one input line and back", async () => {
    api();
    renderApp(
      <Page>
        <ChatPanel fill={false} />
      </Page>,
    );
    await screen.findByTestId("chat-mode");
    fireEvent.click(screen.getByTestId("chat-collapse"));
    expect(screen.getByTestId("chat-panel").getAttribute("data-size")).toBe("collapsed");
    expect(screen.queryByTestId("chat-messages")).toBeNull();
    expect(screen.getByTestId("chat-input")).toBeTruthy();
    fireEvent.click(screen.getByTestId("chat-expand"));
    expect(screen.getByTestId("chat-messages")).toBeTruthy();
  });

  it("explains a selected sentence by pre-filling the input with a quote, without sending", async () => {
    const calls = api();
    renderApp(
      <Page>
        <div data-revision-id="r1" data-explainable>
          <span data-segment-id={CITED_SEGMENT_ID}>再看重排序。</span>
        </div>
        <ChatPanel fill={false} />
        <SelectionToolbar />
      </Page>,
    );
    await screen.findByTestId("chat-mode");
    const sentence = document.querySelector(`[data-segment-id='${CITED_SEGMENT_ID}']`)?.firstChild as Text;
    const range = document.createRange();
    range.setStart(sentence, 2);
    range.setEnd(sentence, 5);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.mouseUp(document);
    fireEvent.click(await screen.findByTestId("selection-explain"));

    await waitFor(() => expect(input().value).toBe("解释一下「重排序」"));
    expect(screen.getByTestId("chat-quote").textContent).toContain("再看重排序。");
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);

    const posted = calls.length;
    fireEvent.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(calls.length).toBeGreaterThan(posted));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      text: "解释一下「重排序」",
      modelRef: MODEL,
      quote: { transcriptRevisionId: "r1", segmentId: CITED_SEGMENT_ID },
    });
  });

  it("drops an earlier quote when a summary selection is explained, so it is not sent along", async () => {
    const calls = api();
    renderApp(
      <Page>
        <div data-revision-id="r1" data-explainable>
          <span data-segment-id={CITED_SEGMENT_ID}>再看重排序。</span>
        </div>
        <div data-testid="summary-body" data-explainable>
          <p>先召回后重排序。</p>
        </div>
        <ChatPanel fill={false} />
        <SelectionToolbar />
      </Page>,
    );
    await screen.findByTestId("chat-mode");
    const select = (node: Text, start: number, end: number): void => {
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      fireEvent.mouseUp(document);
    };
    select(document.querySelector(`[data-segment-id='${CITED_SEGMENT_ID}']`)?.firstChild as Text, 2, 5);
    fireEvent.click(await screen.findByTestId("selection-explain"));
    await waitFor(() => expect(screen.getByTestId("chat-quote")).toBeTruthy());

    select(screen.getByTestId("summary-body").querySelector("p")?.firstChild as Text, 0, 4);
    fireEvent.click(await screen.findByTestId("selection-explain"));
    await waitFor(() => expect(input().value).toBe("解释一下「先召回后」"));
    expect(screen.queryByTestId("chat-quote")).toBeNull();
    fireEvent.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ text: "解释一下「先召回后」", modelRef: MODEL });
  });
});

/** Fires a right click and reports whether the browser menu was prevented. */
function rightClick(element: Element): boolean {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  act(() => {
    element.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

const menuLabels = (): Array<string | null> => screen.getAllByRole("menuitem").map((item) => item.textContent);

describe("chat message context menus", () => {
  function stubClipboard() {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    return writeText;
  }

  const stored = () =>
    chatOf([
      { id: "m1", role: "user", text: "讲了什么？", status: "complete", citations: [], createdAt: 1 },
      {
        id: "m2",
        role: "assistant",
        text: `先看重排序 [[seg:${CITED_SEGMENT_ID}]]，另见 [[unresolved:s9]]。`,
        status: "complete",
        contextTranscriptRevisionId: "r1",
        citations: [{ transcriptRevisionId: "r1", segmentId: CITED_SEGMENT_ID }],
        createdAt: 2,
      },
    ]);

  it("copies an answer with citations turned into timestamps, and jumps only from a resolved citation", async () => {
    const writeText = stubClipboard();
    api({ chat: stored });
    const select = vi.fn();
    const openTab = vi.fn();
    renderApp(
      <ContextMenuHost blockNative={false}>
        <Page select={select} openTab={openTab}>
          <ChatPanel fill={false} />
        </Page>
      </ContextMenuHost>,
    );
    const badge = await screen.findByRole("button", { name: "1:15" });
    const answer = badge.closest("[data-role='assistant']") as HTMLElement;
    expect(rightClick(within(answer).getByText(/先看重排序/))).toBe(true);
    expect(menuLabels()).toEqual(["复制回答"]);
    fireEvent.click(screen.getByTestId("context-menu-item-copy-answer"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("先看重排序 [1:15]，另见 。"));

    rightClick(answer.querySelector("[data-citation='unresolved']") as HTMLElement);
    expect(menuLabels()).toEqual(["复制回答"]);
    fireEvent.keyDown(screen.getByTestId("context-menu"), { key: "Escape" });

    rightClick(badge);
    expect(menuLabels()).toEqual(["复制回答", "跳转到原文"]);
    fireEvent.click(screen.getByTestId("context-menu-item-jump-to-source"));
    expect(select).toHaveBeenCalledWith({ revisionId: "r1", segmentId: CITED_SEGMENT_ID }, 75_000);
    expect(openTab).toHaveBeenCalledWith("transcript");
  });

  it("copies the user's own question", async () => {
    const writeText = stubClipboard();
    api({ chat: stored });
    renderApp(
      <ContextMenuHost blockNative={false}>
        <Page>
          <ChatPanel fill={false} />
        </Page>
      </ContextMenuHost>,
    );
    const question = await screen.findByText("讲了什么？");
    expect(rightClick(question)).toBe(true);
    expect(menuLabels()).toEqual(["复制"]);
    fireEvent.click(screen.getByTestId("context-menu-item-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("讲了什么？"));
  });

  it("greys out copying an answer while it streams", async () => {
    const encoder = new TextEncoder();
    api({
      post: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(frame("answer.delta", { delta: "先看重排序" })));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    renderApp(
      <ContextMenuHost blockNative={false}>
        <Page>
          <ChatPanel fill={false} />
        </Page>
      </ContextMenuHost>,
    );
    await screen.findByTestId("chat-mode");
    fireEvent.change(input(), { target: { value: "讲了什么？" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    const partial = await screen.findByText("先看重排序");
    expect(partial.closest("[data-role='assistant']")?.getAttribute("data-status")).toBe("streaming");
    rightClick(partial);
    expect(screen.getByTestId("context-menu-item-copy-answer").getAttribute("data-disabled")).not.toBeNull();
    fireEvent.click(screen.getByTestId("chat-stop"));
  });
});
