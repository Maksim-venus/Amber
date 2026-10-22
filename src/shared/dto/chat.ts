import { z } from "zod";
import { CHAT_MESSAGE_STATUSES } from "../enums.ts";
import { appErrorSchema } from "../errors.ts";
import { segmentIdSchema } from "../ids.ts";
import { citationDtoSchema } from "./citation.ts";
import { modelRefSchema } from "./model-ref.ts";
import { modelRefSnapshotDtoSchema } from "./usage.ts";

const idSchema = z.string().min(1);
const msSchema = z.number().int().nonnegative();

/** Upper bound of one question; longer input is a client error. */
export const CHAT_MESSAGE_MAX_CHARS = 8000;

/** A sentence quoted from the transcript ("explain"); the server reads its text itself. */
export const chatQuoteSchema = z
  .object({
    transcriptRevisionId: idSchema,
    segmentId: segmentIdSchema,
  })
  .strict();
export type ChatQuote = z.infer<typeof chatQuoteSchema>;

/** `POST /api/contents/:id/chat/messages`. */
export const chatMessageRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(CHAT_MESSAGE_MAX_CHARS),
    modelRef: modelRefSchema,
    quote: chatQuoteSchema.optional(),
    /** Player position when the player tracks time; names the current chapter. */
    positionMs: msSchema.optional(),
  })
  .strict();
export type ChatMessageRequest = z.infer<typeof chatMessageRequestSchema>;

/** `GET /api/contents/:id/chat?providerProfileId=&modelId=`: both or neither. */
export const chatQuerySchema = z
  .object({
    providerProfileId: idSchema.optional(),
    modelId: idSchema.optional(),
  })
  .strict()
  .refine((query) => (query.providerProfileId === undefined) === (query.modelId === undefined), {
    message: "providerProfileId and modelId go together",
  });
export type ChatQuery = z.infer<typeof chatQuerySchema>;

/** `metadata`: no transcript yet, answers rest on the basic facts and the model's own knowledge. */
export const CHAT_CONTEXT_MODES = ["full", "retrieval", "metadata", "unavailable"] as const;
export type ChatContextMode = (typeof CHAT_CONTEXT_MODES)[number];

/** Why the context is `unavailable`. */
export const CHAT_CONTEXT_REASONS = ["no_model", "context_window_unknown"] as const;
export type ChatContextReason = (typeof CHAT_CONTEXT_REASONS)[number];

export const chatContextDtoSchema = z.object({
  mode: z.enum(CHAT_CONTEXT_MODES),
  /** A planning estimate for the label's hover, never a precise count. */
  estimatedTokens: z.number().int().nonnegative().optional(),
  reason: z.enum(CHAT_CONTEXT_REASONS).optional(),
});
export type ChatContextDto = z.infer<typeof chatContextDtoSchema>;

/**
 * One message. Citations appear in `text` as canonical `[[seg:<segmentId>]]` markers and
 * are indexed in `citations`; a user message's `quote` is the sentence it asked about. An
 * assistant message without `contextTranscriptRevisionId` was answered without a transcript.
 */
export const chatMessageDtoSchema = z.object({
  id: idSchema,
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  status: z.enum(CHAT_MESSAGE_STATUSES),
  modelRef: modelRefSnapshotDtoSchema.optional(),
  contextTranscriptRevisionId: idSchema.optional(),
  citations: z.array(citationDtoSchema),
  suggestions: z.array(z.string()).optional(),
  quote: chatQuoteSchema.optional(),
  createdAt: msSchema,
});
export type ChatMessageDto = z.infer<typeof chatMessageDtoSchema>;

export const chatThreadDtoSchema = z.object({ id: idSchema, currentCompactionId: idSchema.optional() });
export type ChatThreadDto = z.infer<typeof chatThreadDtoSchema>;

/** `GET /api/contents/:id/chat`: the whole history, oldest first; `thread` is null before the first message. */
export const chatDtoSchema = z.object({
  thread: chatThreadDtoSchema.nullable(),
  messages: z.array(chatMessageDtoSchema),
  context: chatContextDtoSchema,
});
export type ChatDto = z.infer<typeof chatDtoSchema>;

/** `Idempotency-Key` replay of a POST: the assistant message as stored. */
export const chatReplayDtoSchema = z.object({ message: chatMessageDtoSchema });
export type ChatReplayDto = z.infer<typeof chatReplayDtoSchema>;

/**
 * The SSE events of a chat answer: `answer.delta` carries canonical markers
 * only; `citation` announces each newly cited sentence with its start time; the control
 * section never reaches the client, only `suggestions`; `done` closes the stream.
 */
export const chatStreamEventSchemas = {
  "answer.delta": z.object({ delta: z.string() }),
  citation: citationDtoSchema.extend({ startMs: msSchema }),
  suggestions: z.object({ items: z.array(z.string()) }),
  usage: z.object({ inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional() }),
  done: z.object({
    userMessageId: idSchema,
    messageId: idSchema,
    status: z.enum(CHAT_MESSAGE_STATUSES),
    error: appErrorSchema.optional(),
  }),
} as const;
export type ChatStreamEventType = keyof typeof chatStreamEventSchemas;
export type ChatStreamEvent = { [K in ChatStreamEventType]: { type: K; data: z.infer<(typeof chatStreamEventSchemas)[K]> } }[ChatStreamEventType];
