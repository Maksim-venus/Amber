import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Copy, CornerDownRight, Maximize2, MessageSquare, Minimize2, Quote, Send, Square, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { z } from "zod";
import type { ChatContextDto, ChatQuote, ChatStreamEvent } from "../../shared/dto/chat.ts";
import type { ModelRefDto } from "../../shared/dto/model-ref.ts";
import type { ChatMessageStatus } from "../../shared/enums.ts";
import type { AppError } from "../../shared/errors.ts";
import { ApiError } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { queryKeys, useProviders, useSettings } from "../api/queries.ts";
import { ErrorView } from "../components/error-view.tsx";
import { plainText } from "../components/plain-text.ts";
import { RichText } from "../components/rich-text.tsx";
import { useContentPage } from "../pages/content/content-context.tsx";
import { ConfirmDialog } from "../pages/content/confirm-dialog.tsx";
import { useSegments } from "../pages/content/content-data.ts";
import { usePlayerController } from "../player/player-controller.tsx";
import { Button } from "../ui/button.tsx";
import { copyText } from "../ui/clipboard.ts";
import { useContextMenuTarget, type MenuAction } from "../ui/context-menu.tsx";
import { Spinner } from "../ui/feedback.tsx";
import { useChatComposer, useComposerState, type QuoteDraft } from "./chat-composer.tsx";
import { chatKeys, chatModelOptions, defaultChatModel, modelKey, useChat } from "./chat-data.ts";
import { readChatAnswer } from "./chat-stream.ts";

type PanelSize = "collapsed" | "normal" | "full";

/** The answer being streamed, shown until the stored thread is read back. */
export interface PendingTurn {
  question: string;
  quote: QuoteDraft | undefined;
  answer: string;
  /** Start times and revisions announced by `citation` events. */
  cited: Map<string, { transcriptRevisionId: string; startMs: number }>;
  suggestions: string[] | undefined;
  status: ChatMessageStatus;
  error: AppError | undefined;
  /** Sent while the context was `metadata`: the answer is not grounded in the video. */
  ungrounded: boolean;
}

const CONTEXT_WINDOW_UNKNOWN = "llm_capability.context_window_unknown";

/** Folds one SSE event of the answer into the pending turn. */
export function applyChatEvent(turn: PendingTurn, event: ChatStreamEvent): PendingTurn {
  switch (event.type) {
    case "answer.delta":
      return { ...turn, answer: turn.answer + event.data.delta };
    case "citation": {
      const cited = new Map(turn.cited);
      cited.set(event.data.segmentId, { transcriptRevisionId: event.data.transcriptRevisionId, startMs: event.data.startMs });
      return { ...turn, cited };
    }
    case "suggestions":
      return { ...turn, suggestions: event.data.items };
    case "usage":
      return turn;
    case "done":
      return { ...turn, status: event.data.status, error: event.data.error };
  }
}

/**
 * The dialogue area of the middle column: one persistent thread per
 * Content, streamed answers with clickable citations, the model selector and the context
 * mode label. It folds to a single input line, and fills the column when asked to or when
 * the player is hidden. Nothing is sent without the user pressing send.
 */
export function ChatPanel(props: { fill: boolean }) {
  const { t } = useTranslation();
  const page = useContentPage();
  const contentId = page.content.id;
  const client = useApi();
  const queryClient = useQueryClient();
  const player = usePlayerController();
  const providers = useProviders();
  const settings = useSettings();
  const composer = useChatComposer();
  const composed = useComposerState();
  const options = useMemo(() => chatModelOptions(providers.data?.items ?? []), [providers.data]);
  const [picked, setPicked] = useState<ModelRefDto | undefined>(undefined);
  const modelRef = picked ?? defaultChatModel(options, settings.data);
  const ready = !providers.isPending && !settings.isPending;
  const chat = useChat(contentId, modelRef, ready);
  const [size, setSize] = useState<PanelSize>("normal");
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<PendingTurn | undefined>(undefined);
  const [sendError, setSendError] = useState<AppError | undefined>(undefined);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const running = useRef<AbortController | undefined>(undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // "Explain" from the selection toolbar: the question is pre-filled, never sent.
  const prefillSeq = composed.prefill?.seq;
  useEffect(() => {
    if (composed.prefill === undefined) return;
    setInput(composed.prefill.text);
    setSize((current) => (current === "collapsed" ? "normal" : current));
    inputRef.current?.focus();
    // Keyed by the request number: only a new "explain" re-fills the input.
  }, [prefillSeq]);

  useEffect(() => () => running.current?.abort(), []);

  const messages = chat.data?.messages ?? [];
  useEffect(() => {
    const list = listRef.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [messages.length, pending?.answer, pending?.status]);

  const context: ChatContextDto | undefined = chat.data?.context;
  const contextUnknown = sendError?.code === CONTEXT_WINDOW_UNKNOWN;
  const unavailableReason = modelRef === undefined && providers.isSuccess ? "no_model" : contextUnknown ? "context_window_unknown" : context?.mode === "unavailable" ? context.reason : undefined;
  const blocked = unavailableReason !== undefined || modelRef === undefined;
  const streaming = pending?.status === "streaming";
  const path = `/api/contents/${encodeURIComponent(contentId)}/chat`;

  const send = async (): Promise<void> => {
    const text = input.trim();
    if (text === "" || modelRef === undefined || blocked || streaming) return;
    const quote = composed.quote;
    const positionMs = player.capabilities.timeTracking === "supported" ? player.currentTimeMs() : undefined;
    const body = {
      text,
      modelRef,
      ...(quote === undefined ? {} : { quote: { transcriptRevisionId: quote.transcriptRevisionId, segmentId: quote.segmentId } satisfies ChatQuote }),
      ...(positionMs === undefined ? {} : { positionMs: Math.max(0, Math.round(positionMs)) }),
    };
    setPending({ question: text, quote, answer: "", cited: new Map(), suggestions: undefined, status: "streaming", error: undefined, ungrounded: context?.mode === "metadata" });
    setInput("");
    setSendError(undefined);
    composer.clearQuote();
    setSize((current) => (current === "collapsed" ? "normal" : current));
    const controller = new AbortController();
    running.current = controller;
    let persisted = true;
    try {
      const response = await client.postStream(`${path}/messages`, { body, idempotent: true, signal: controller.signal });
      const outcome = await readChatAnswer(response, (event) => setPending((turn) => (turn === undefined ? turn : applyChatEvent(turn, event))));
      if (outcome.kind === "stream" && !outcome.done) {
        setPending((turn) => (turn === undefined ? turn : { ...turn, status: "interrupted" }));
      }
    } catch (error) {
      if (error instanceof ApiError) {
        // Refused before anything was stored: give the question back.
        persisted = false;
        setPending(undefined);
        setSendError(error.error);
        setInput(text);
        if (quote !== undefined) composer.explain(quote, text);
      } else {
        setPending((turn) => (turn === undefined ? turn : { ...turn, status: "interrupted" }));
      }
    } finally {
      running.current = undefined;
    }
    if (persisted) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: chatKeys.all(contentId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
      ]);
      setPending(undefined);
    }
  };

  const clear = async (): Promise<void> => {
    setClearing(true);
    try {
      await client.delete(path, z.undefined());
      await queryClient.invalidateQueries({ queryKey: chatKeys.all(contentId) });
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const fill = props.fill || size === "full";
  const frame = size === "collapsed" ? "" : fill ? "min-h-96 flex-1" : "h-96";

  const collapsed = size === "collapsed";
  const sendOrStop = streaming ? (
    <button
      type="button"
      className="flex size-8 shrink-0 items-center justify-center rounded-md bg-ink text-surface hover:opacity-80"
      onClick={() => running.current?.abort()}
      title={t("chat.stop")}
      aria-label={t("chat.stop")}
      data-testid="chat-stop"
    >
      <Square size={12} fill="currentColor" aria-hidden="true" />
    </button>
  ) : (
    <button
      type="button"
      className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-glow text-accent-ink hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
      disabled={blocked || input.trim() === ""}
      onClick={() => void send()}
      title={t("chat.send")}
      aria-label={t("chat.send")}
      data-testid="chat-send"
    >
      <Send size={14} aria-hidden="true" />
    </button>
  );

  // One box like a chat app's: the quote above the text, the model, the context mode and
  // send along its bottom edge.
  const composerRow = (
    <div className="flex items-end gap-2">
      {collapsed ? <MessageSquare size={14} className="mb-2.5 shrink-0 text-muted" aria-hidden="true" /> : null}
      <div
        className={`flex min-w-0 flex-1 flex-col rounded-lg border border-line bg-surface focus-within:border-accent ${blocked ? "opacity-60" : ""}`}
        data-testid="chat-box"
      >
        {composed.quote === undefined ? null : (
          <div className="mx-2 mt-2 flex items-start gap-2 rounded-md bg-sunken px-2 py-1 text-xs" data-testid="chat-quote">
            <Quote size={12} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
            <span className="line-clamp-2 flex-1">{composed.quote.text}</span>
            <button type="button" aria-label={t("chat.quote.remove")} className="text-muted hover:text-ink" onClick={() => composer.clearQuote()}>
              <X size={12} />
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            rows={collapsed ? 1 : 2}
            value={input}
            disabled={blocked}
            placeholder={t("chat.placeholder")}
            aria-label={t("chat.placeholder")}
            data-testid="chat-input"
            className="min-h-8 flex-1 resize-none bg-transparent px-3 py-2 text-sm outline-none disabled:cursor-not-allowed"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {collapsed ? <div className="p-1">{sendOrStop}</div> : null}
        </div>
        {collapsed ? null : (
          <div className="flex items-center gap-2 px-2 pb-2 text-xs text-muted">
            {options.length === 0 ? null : (
              <select
                aria-label={t("chat.model")}
                title={t("chat.model")}
                data-testid="chat-model"
                className="h-7 max-w-64 min-w-0 truncate rounded-md border border-line bg-surface px-1.5 text-xs text-ink hover:border-accent"
                value={modelRef === undefined ? "" : modelKey(modelRef)}
                onChange={(event) => {
                  setSendError(undefined);
                  setPicked(options.find((option) => modelKey(option.modelRef) === event.target.value)?.modelRef);
                }}
              >
                {options.map((option) => (
                  <option key={modelKey(option.modelRef)} value={modelKey(option.modelRef)}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
            {context !== undefined && context.mode !== "unavailable" && !contextUnknown ? (
              <span
                className="rounded bg-sunken px-1.5 py-0.5"
                data-testid="chat-mode"
                data-mode={context.mode}
                title={context.estimatedTokens === undefined ? undefined : t("chat.mode.estimate", { tokens: context.estimatedTokens.toLocaleString() })}
              >
                {t(`chat.mode.${context.mode}`)}
              </span>
            ) : null}
            <div className="ml-auto">{sendOrStop}</div>
          </div>
        )}
      </div>
      {collapsed ? (
        <Button size="sm" variant="ghost" aria-label={t("chat.expand")} title={t("chat.expand")} onClick={() => setSize("normal")} data-testid="chat-expand">
          <ChevronUp size={14} />
        </Button>
      ) : null}
    </div>
  );

  return (
    <section className={`flex flex-col gap-2 rounded-md border border-line p-3 ${frame}`} data-testid="chat-panel" data-size={size}>
      {size === "collapsed" ? null : (
        <header className="flex items-center gap-2">
          <MessageSquare size={14} className="text-muted" aria-hidden="true" />
          <h2 className="text-sm font-medium">{t("chat.title")}</h2>
          <div className="ml-auto flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={messages.length === 0 || streaming}
              onClick={() => setConfirmClear(true)}
              title={t("chat.clear")}
              aria-label={t("chat.clear")}
              data-testid="chat-clear"
            >
              <Trash2 size={14} />
            </Button>
            {props.fill ? null : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSize(size === "full" ? "normal" : "full")}
                title={size === "full" ? t("chat.restore") : t("chat.full")}
                aria-label={size === "full" ? t("chat.restore") : t("chat.full")}
                data-testid="chat-full"
              >
                {size === "full" ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setSize("collapsed")} title={t("chat.collapse")} aria-label={t("chat.collapse")} data-testid="chat-collapse">
              <ChevronDown size={14} />
            </Button>
          </div>
        </header>
      )}
      {size === "collapsed" ? null : (
        <div ref={listRef} className="min-h-0 flex-1 overflow-auto" data-testid="chat-messages">
          {messages.length === 0 && pending === undefined ? <p className="py-6 text-center text-xs text-muted">{t("chat.empty")}</p> : null}
          {messages.map((message) =>
            message.role === "user" ? (
              <UserMessage key={message.id} text={message.text} quote={message.quote} />
            ) : (
              <AssistantMessage
                key={message.id}
                text={message.text}
                status={message.status}
                revisionId={message.contextTranscriptRevisionId}
                ungrounded={message.contextTranscriptRevisionId === undefined}
                citations={message.citations}
                suggestions={pending === undefined && message.id === lastAssistant?.id ? message.suggestions : undefined}
                onSuggestion={(text) => {
                  setInput(text);
                  inputRef.current?.focus();
                }}
              />
            ),
          )}
          {pending === undefined ? null : (
            <>
              <UserMessage text={pending.question} quote={pending.quote} quoteText={pending.quote?.text} />
              <AssistantMessage
                text={pending.answer}
                status={pending.status}
                revisionId={pending.cited.values().next().value?.transcriptRevisionId ?? page.primaryRevisionId}
                ungrounded={pending.ungrounded}
                citations={[...pending.cited].map(([segmentId, cited]) => ({ segmentId, transcriptRevisionId: cited.transcriptRevisionId }))}
                knownTimes={pending.cited}
                suggestions={pending.status === "complete" ? pending.suggestions : undefined}
                error={pending.error}
                onSuggestion={(text) => {
                  setInput(text);
                  inputRef.current?.focus();
                }}
              />
            </>
          )}
        </div>
      )}
      {unavailableReason === undefined ? null : <Unavailable reason={unavailableReason} />}
      {unavailableReason === undefined && context?.mode === "metadata" ? (
        <p className="rounded-md bg-sunken px-2 py-1.5 text-xs text-muted" data-testid="chat-metadata-hint">
          {t("chat.metadataHint")}
        </p>
      ) : null}
      {sendError === undefined || contextUnknown ? null : <ErrorView error={sendError} />}
      {composerRow}
      <ConfirmDialog
        open={confirmClear}
        title={t("chat.clear")}
        message={t("chat.clearConfirm")}
        confirmLabel={t("chat.clear")}
        busy={clearing}
        onConfirm={() => void clear()}
        onCancel={() => setConfirmClear(false)}
      />
    </section>
  );
}

function Unavailable(props: { reason: "no_model" | "context_window_unknown" }) {
  const { t } = useTranslation();
  return (
    <p className="flex flex-wrap items-center gap-2 rounded-md bg-sunken px-2 py-1.5 text-xs text-muted" data-testid="chat-unavailable" data-reason={props.reason}>
      {t(`chat.unavailable.${props.reason}`)}
      <Link to="/settings/models" className="text-accent hover:underline" data-testid="chat-configure">
        {t("chat.configure")}
      </Link>
    </p>
  );
}

function UserMessage(props: { text: string; quote: ChatQuote | undefined; quoteText?: string | undefined }) {
  const { t } = useTranslation();
  const segments = useSegments(props.quoteText === undefined ? props.quote?.transcriptRevisionId : undefined);
  const quoted = props.quoteText ?? segments.data?.find((segment) => segment.id === props.quote?.segmentId)?.text;
  const text = props.text;
  const menuTarget = useContextMenuTarget<HTMLDivElement>(() => ({
    kind: "text",
    entries: [{ id: "copy", label: t("common.action.copy"), icon: <Copy size={14} aria-hidden="true" />, onSelect: () => void copyText(text) }],
  }));
  return (
    <div ref={menuTarget} className="my-2 flex flex-col items-end gap-1" data-testid="chat-message" data-role="user">
      {props.quote === undefined ? null : (
        <p className="flex max-w-[85%] items-start gap-1 rounded bg-sunken px-2 py-1 text-xs text-muted">
          <Quote size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="line-clamp-2">{quoted ?? ""}</span>
        </p>
      )}
      <p className="max-w-[85%] rounded-md bg-accent-soft px-3 py-1.5 text-sm whitespace-pre-wrap">{props.text}</p>
    </div>
  );
}

function AssistantMessage(props: {
  text: string;
  status: ChatMessageStatus;
  revisionId: string | undefined;
  citations: ReadonlyArray<{ transcriptRevisionId: string; segmentId: string }>;
  knownTimes?: ReadonlyMap<string, { startMs: number }>;
  suggestions: string[] | undefined;
  error?: AppError | undefined;
  /** Answered before the Content had a transcript (metadata mode): always labelled as such. */
  ungrounded: boolean;
  onSuggestion: (text: string) => void;
}) {
  const { t } = useTranslation();
  const page = useContentPage();
  const segments = useSegments(props.revisionId);
  const times = useMemo(() => {
    const map = new Map((segments.data ?? []).map((segment) => [segment.id as string, segment.startMs]));
    for (const [segmentId, known] of props.knownTimes ?? []) map.set(segmentId, known.startMs);
    return map;
  }, [segments.data, props.knownTimes]);
  // A citation opens exactly the revision the answer relied on.
  const onCitation = (segmentId: string): void => {
    const revisionId = props.citations.find((citation) => citation.segmentId === segmentId)?.transcriptRevisionId ?? props.revisionId;
    if (revisionId === undefined) return;
    page.select({ revisionId, segmentId }, times.get(segmentId));
    page.openTab("transcript");
  };
  const menuTarget = useContextMenuTarget<HTMLDivElement>((hit) => {
    // Snapshot of the answer as shown now; a streaming or empty answer has nothing to copy yet.
    const answer = plainText(props.text, (segmentId) => times.get(segmentId));
    const copyable = props.status !== "streaming" && props.text !== "";
    const cited = hit.target.closest<HTMLElement>("[data-citation]")?.dataset["citation"];
    const entries: MenuAction[] = [
      { id: "copy-answer", label: t("common.menu.copyAnswer"), icon: <Copy size={14} aria-hidden="true" />, disabled: !copyable, onSelect: () => void copyText(answer) },
    ];
    // An unresolved citation names no sentence, so there is nothing to jump to.
    if (cited !== undefined && cited !== "unresolved") {
      entries.push({ id: "jump-to-source", label: t("common.menu.jumpToSource"), icon: <CornerDownRight size={14} aria-hidden="true" />, onSelect: () => onCitation(cited) });
    }
    return { kind: "text", entries };
  });
  return (
    <div ref={menuTarget} className="my-2" data-testid="chat-message" data-role="assistant" data-status={props.status}>
      {props.ungrounded ? (
        <span className="mb-1 inline-block rounded bg-sunken px-1.5 py-0.5 text-xs text-muted" data-testid="chat-ungrounded">
          {t("chat.ungrounded")}
        </span>
      ) : null}
      {props.text === "" && props.status === "streaming" ? (
        <span className="flex items-center gap-2 text-xs text-muted">
          <Spinner size={12} />
          {t("chat.status.streaming")}
        </span>
      ) : (
        <RichText source={props.text} timeOf={(segmentId) => times.get(segmentId)} onCitation={onCitation} />
      )}
      {props.status === "interrupted" || props.status === "failed" ? (
        <p className="mt-1 text-xs text-danger" data-testid="chat-message-status">
          {t(`chat.status.${props.status}`)}
        </p>
      ) : null}
      {props.error === undefined ? null : <ErrorView error={props.error} />}
      {props.suggestions === undefined || props.suggestions.length === 0 ? null : (
        <div className="mt-2 flex flex-wrap gap-1.5" aria-label={t("chat.suggestions")}>
          {props.suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="rounded-full border border-line px-2 py-0.5 text-xs hover:border-accent hover:text-accent"
              data-testid="chat-suggestion"
              onClick={() => props.onSuggestion(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
