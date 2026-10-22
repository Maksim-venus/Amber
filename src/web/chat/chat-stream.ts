import { chatReplayDtoSchema, chatStreamEventSchemas, type ChatMessageDto, type ChatStreamEvent, type ChatStreamEventType } from "../../shared/dto/chat.ts";
import { SseParser, type RawSseFrame } from "../api/sse.ts";

/** How a chat POST ended up: a live stream that was read to its end, or a replay of a stored answer. */
export type ChatAnswerOutcome = { kind: "stream"; done: boolean } | { kind: "replay"; message: ChatMessageDto };

function isEventType(type: string): type is ChatStreamEventType {
  return Object.hasOwn(chatStreamEventSchemas, type);
}

/** A validated chat event, or undefined for unknown types and frames that do not match the contract. */
export function chatEventOf(frame: RawSseFrame): ChatStreamEvent | undefined {
  if (!isEventType(frame.event)) {
    return undefined;
  }
  let data: unknown;
  try {
    data = JSON.parse(frame.data);
  } catch {
    return undefined;
  }
  const parsed = chatStreamEventSchemas[frame.event].safeParse(data);
  return parsed.success ? ({ type: frame.event, data: parsed.data } as ChatStreamEvent) : undefined;
}

/**
 * Reads the answer of `POST /api/contents/:id/chat/messages`: SSE frames are validated and
 * handed over one by one; a JSON body is an Idempotency-Key replay of the stored message
 * `done` tells whether the stream reached its `done` event.
 */
export async function readChatAnswer(response: Response, onEvent: (event: ChatStreamEvent) => void): Promise<ChatAnswerOutcome> {
  if ((response.headers.get("content-type") ?? "").includes("application/json")) {
    const message = chatReplayDtoSchema.parse(await response.json()).message;
    return { kind: "replay", message };
  }
  const body = response.body;
  if (body === null) {
    return { kind: "stream", done: false };
  }
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let done = false;
  const deliver = (frames: RawSseFrame[]): void => {
    for (const frame of frames) {
      const event = chatEventOf(frame);
      if (event !== undefined) {
        done ||= event.type === "done";
        onEvent(event);
      }
    }
  };
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      deliver(parser.push(`${decoder.decode()}\n\n`));
      break;
    }
    deliver(parser.push(decoder.decode(chunk.value, { stream: true })));
  }
  return { kind: "stream", done };
}
