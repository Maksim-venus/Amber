import { describe, expect, it } from "vitest";
import { SSE_RECONNECT_BASE_MS, SSE_RECONNECT_MAX_MS } from "../../../src/shared/defaults.ts";
import { connectSse, reconnectDelay, SseParser, type RawSseFrame } from "../../../src/web/api/sse.ts";

describe("SseParser", () => {
  it("assembles frames across chunk boundaries and drops comments", () => {
    const parser = new SseParser();
    expect(parser.push(": heartbeat\n\nevent: task.updated\ndata: {\"a\"")).toEqual([]);
    expect(parser.push(":1}\nid: 7\n\nevent: x\r\ndata: line1\r\ndata: line2\r\n\r\n")).toEqual([
      { event: "task.updated", data: '{"a":1}', id: 7 },
      { event: "x", data: "line1\nline2" },
    ]);
  });
});

describe("reconnectDelay", () => {
  it("doubles from the base and stops at the cap", () => {
    expect(reconnectDelay(0)).toBe(SSE_RECONNECT_BASE_MS);
    expect(reconnectDelay(1)).toBe(SSE_RECONNECT_BASE_MS * 2);
    expect(reconnectDelay(50)).toBe(SSE_RECONNECT_MAX_MS);
  });
});

describe("connectSse", () => {
  it("reconnects after the stream ends and reports every (re)open", async () => {
    const frames: RawSseFrame[] = [];
    let opens = 0;
    let attempts = 0;
    const delays: number[] = [];
    const done = new Promise<void>((resolve) => {
      const connection = connectSse({
        open: async () => {
          attempts += 1;
          if (attempts === 2) {
            throw new Error("down");
          }
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`event: e\ndata: ${attempts}\nid: ${attempts}\n\n`));
              controller.close();
            },
          });
          return new Response(body);
        },
        onFrame: (frame) => {
          frames.push(frame);
          if (frames.length === 2) {
            connection.close();
            resolve();
          }
        },
        onOpen: () => {
          opens += 1;
        },
        sleep: async (ms) => {
          delays.push(ms);
        },
      });
    });
    await done;
    expect(frames.map((frame) => frame.data)).toEqual(["1", "3"]);
    expect(opens).toBe(2);
    // The successful open resets the backoff; the failed attempt doubles it once.
    expect(delays).toEqual([SSE_RECONNECT_BASE_MS, SSE_RECONNECT_BASE_MS * 2]);
  });
});
