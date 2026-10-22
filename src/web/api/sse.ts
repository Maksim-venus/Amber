import { SSE_RECONNECT_BASE_MS, SSE_RECONNECT_MAX_MS } from "../../shared/defaults.ts";

/** One `event:` / `data:` / `id:` frame of the API's SSE envelope. */
export interface RawSseFrame {
  event: string;
  data: string;
  id?: number;
}

/**
 * Incremental SSE parser: feed decoded text chunks, get complete frames. Comment lines
 * (heartbeats) and frames without data are dropped; multi-line data is joined with "\n".
 */
export class SseParser {
  private buffer = "";

  push(chunk: string): RawSseFrame[] {
    this.buffer += chunk.replace(/\r\n?/g, "\n");
    const frames: RawSseFrame[] = [];
    let end = this.buffer.indexOf("\n\n");
    while (end !== -1) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const frame = parseBlock(block);
      if (frame !== undefined) {
        frames.push(frame);
      }
      end = this.buffer.indexOf("\n\n");
    }
    return frames;
  }
}

function parseBlock(block: string): RawSseFrame | undefined {
  let event = "message";
  const data: string[] = [];
  let id: number | undefined;
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) {
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") {
      event = value;
    } else if (field === "data") {
      data.push(value);
    } else if (field === "id" && /^\d+$/.test(value)) {
      id = Number(value);
    }
  }
  return data.length === 0 ? undefined : { event, data: data.join("\n"), ...(id === undefined ? {} : { id }) };
}

/** Exponential reconnect delay for the given consecutive failure count. */
export function reconnectDelay(failures: number): number {
  return Math.min(SSE_RECONNECT_MAX_MS, SSE_RECONNECT_BASE_MS * 2 ** Math.max(0, failures));
}

export interface SseConnection {
  close(): void;
}

/**
 * Keeps one SSE stream open, reconnecting with backoff. `onOpen` runs on every
 * (re)connection: subscribers re-read their snapshots then, since events are not replayed.
 */
export function connectSse(options: {
  open: (signal: AbortSignal) => Promise<Response>;
  onFrame: (frame: RawSseFrame) => void;
  onOpen?: () => void;
  onDown?: () => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): SseConnection {
  const controller = new AbortController();
  const sleep = options.sleep ?? defaultSleep;
  void (async () => {
    let failures = 0;
    while (!controller.signal.aborted) {
      try {
        const response = await options.open(controller.signal);
        const body = response.body;
        if (body === null) {
          throw new Error("SSE response has no body");
        }
        failures = 0;
        options.onOpen?.();
        const parser = new SseParser();
        const decoder = new TextDecoder();
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
            options.onFrame(frame);
          }
        }
      } catch {
        // Fall through to the reconnect delay.
      }
      if (controller.signal.aborted) {
        return;
      }
      options.onDown?.();
      await sleep(reconnectDelay(failures), controller.signal);
      failures += 1;
    }
  })();
  return { close: () => controller.abort() };
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
