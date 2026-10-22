import type { OutboundHttpClient, OutboundRequest, OutboundResponse } from "../../../src/server/ports/outbound-http.ts";

/**
 * Answers every request with a recorded body, cut into chunks of `chunkBytes` so parsers
 * see arbitrary boundaries; requests are kept for inspection (headers stay in memory only).
 */
export class ReplayHttp implements OutboundHttpClient {
  readonly requests: OutboundRequest[] = [];
  private readonly answer: () => { status: number; body: string };
  private readonly chunkBytes: number;

  constructor(answer: () => { status: number; body: string }, chunkBytes = 7) {
    this.answer = answer;
    this.chunkBytes = chunkBytes;
  }

  async request(request: OutboundRequest): Promise<OutboundResponse> {
    this.requests.push(request);
    const { status, body } = this.answer();
    const bytes = new TextEncoder().encode(body);
    const size = this.chunkBytes;
    const stream = (async function* (): AsyncIterable<Uint8Array> {
      for (let offset = 0; offset < bytes.length; offset += size) {
        yield bytes.subarray(offset, offset + size);
      }
    })();
    return {
      status,
      headers: new Map([["content-type", body.startsWith("{") ? "application/json" : "text/event-stream"]]),
      body: stream,
      text: async () => body,
    };
  }

  /** The JSON body of request `index`. */
  bodyOf(index: number): Record<string, unknown> {
    const body = this.requests[index]?.body;
    if (typeof body !== "string") {
      throw new Error(`request ${index} has no JSON body`);
    }
    return JSON.parse(body) as Record<string, unknown>;
  }
}
