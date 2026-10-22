import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DirectOutboundHttpClient } from "../../../../src/server/adapters/outbound-http/direct.ts";
import { OutboundHttpError, type OutboundStreamBody } from "../../../../src/server/ports/outbound-http.ts";

// Every request goes to a server on 127.0.0.1 started by the test itself.
const servers: Array<{ close(): unknown }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function listen(server: Server | ReturnType<typeof createTcpServer>): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const client = new DirectOutboundHttpClient();
const signal = () => new AbortController().signal;

const CHUNK_BYTES = 64 * 1024;

/** A streamed body of `count` chunks; `beforeChunk` may hold back the producer at a given index. */
function streamBody(count: number, options: { beforeChunk?: (index: number) => Promise<void>; contentLength?: number } = {}) {
  const produced = { chunks: 0 };
  async function* chunks(): AsyncIterable<Uint8Array> {
    for (let index = 0; index < count; index += 1) {
      await options.beforeChunk?.(index);
      produced.chunks += 1;
      yield new Uint8Array(CHUNK_BYTES).fill(index % 256);
    }
  }
  const body: OutboundStreamBody = {
    stream: chunks(),
    contentType: "application/octet-stream",
    contentLength: options.contentLength ?? count * CHUNK_BYTES,
  };
  return { body, produced };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function failureOf(work: Promise<unknown>): Promise<{ phase: string; reason: string }> {
  try {
    await work;
  } catch (error) {
    if (error instanceof OutboundHttpError) return { phase: error.phase, reason: error.reason };
    throw error;
  }
  throw new Error("request unexpectedly succeeded");
}

describe("DirectOutboundHttpClient", () => {
  it("sends method, headers and body and returns status, lower-cased headers and text", async () => {
    const base = await listen(
      createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          response.setHeader("X-Echo", `${request.method} ${request.headers["x-test"]}`);
          response.end(body.toUpperCase());
        });
      }),
    );
    const response = await client.request({ url: `${base}/echo`, method: "POST", headers: { "X-Test": "1" }, body: "hello", signal: signal() });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-echo")).toBe("POST 1");
    expect(await response.text()).toBe("HELLO");
  });

  it("keeps each Set-Cookie header apart, commas in Expires included", async () => {
    const cookies = ["a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/", "b=2; HttpOnly"];
    const base = await listen(createServer((_request, response) => response.setHeader("Set-Cookie", cookies).end()));
    const response = await client.request({ url: base, method: "GET", signal: signal() });
    expect(response.setCookies).toEqual(cookies);
    const plain = await listen(createServer((_request, response) => response.end()));
    expect((await client.request({ url: plain, method: "GET", signal: signal() })).setCookies).toBeUndefined();
  });

  it("encodes FormData as multipart with its boundary", async () => {
    let contentType = "";
    let body = "";
    const base = await listen(
      createServer((request, response) => {
        contentType = request.headers["content-type"] ?? "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => response.end("ok"));
      }),
    );
    const form = new FormData();
    form.append("model_id", "m");
    await (await client.request({ url: base, method: "POST", body: form, signal: signal() })).text();
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(body).toContain('name="model_id"');
  });

  it("returns redirects without following them", async () => {
    const base = await listen(createServer((_request, response) => response.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" }).end()));
    const response = await client.request({ url: base, method: "GET", signal: signal() });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://127.0.0.1:1/elsewhere");
  });

  it("classifies a refused connection as before_send", async () => {
    const tcp = createTcpServer();
    const base = await listen(tcp);
    tcp.close();
    servers.pop();
    expect(await failureOf(client.request({ url: base, method: "GET", signal: signal() }))).toEqual({ phase: "before_send", reason: "network" });
  });

  it("classifies a connection dropped after a GET was sent as after_send", async () => {
    const base = await listen(createServer((request) => request.socket.destroy()));
    expect(await failureOf(client.request({ url: base, method: "GET", signal: signal() }))).toEqual({ phase: "after_send", reason: "network" });
  });

  it("classifies a connection dropped after the request was sent as after_send", async () => {
    const base = await listen(createServer((request) => request.socket.destroy()));
    expect(await failureOf(client.request({ url: base, method: "POST", body: "x", signal: signal() }))).toEqual({ phase: "after_send", reason: "network" });
  });

  it("classifies a timeout while waiting for the response as after_send", async () => {
    const base = await listen(createServer(() => undefined));
    expect(await failureOf(client.request({ url: base, method: "GET", timeoutMs: 50, signal: signal() }))).toEqual({ phase: "after_send", reason: "timeout" });
  });

  it("aborts on the signal", async () => {
    const base = await listen(createServer(() => undefined));
    const controller = new AbortController();
    const pending = client.request({ url: base, method: "GET", signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    expect((await failureOf(pending)).reason).toBe("aborted");
  });

  it("reports a truncated body as an after_send failure", async () => {
    const base = await listen(
      createServer((_request, response) => {
        response.writeHead(200, { "content-length": "100" });
        response.write("partial");
        setTimeout(() => response.socket?.destroy(), 10);
      }),
    );
    const response = await client.request({ url: base, method: "GET", signal: signal() });
    expect(await failureOf(response.text())).toEqual({ phase: "after_send", reason: "network" });
  });

  describe("streamed bodies", () => {
    it("sends every chunk with the declared length and content type", async () => {
      let received = 0;
      let headers: Record<string, string | string[] | undefined> = {};
      const base = await listen(
        createServer((request, response) => {
          headers = request.headers;
          request.on("data", (chunk: Buffer) => (received += chunk.length));
          request.on("end", () => response.end(String(received)));
        }),
      );
      const { body } = streamBody(8);
      const response = await client.request({ url: base, method: "POST", body, signal: signal() });
      expect(await response.text()).toBe(String(8 * CHUNK_BYTES));
      expect(headers["content-length"]).toBe(String(8 * CHUNK_BYTES));
      expect(headers["content-type"]).toBe("application/octet-stream");
    });

    it("classifies a connection dropped before the last chunk as before_send", async () => {
      const dropped = deferred();
      const base = await listen(
        createServer((request) => {
          request.once("data", () => {
            request.socket.destroy();
            dropped.resolve();
          });
        }),
      );
      // The producer stalls before chunk 3 until the server has dropped the connection, so
      // the last of the 8 chunks can never have been handed over.
      const { body, produced } = streamBody(8, { beforeChunk: (index) => (index === 3 ? dropped.promise : Promise.resolve()) });
      expect(await failureOf(client.request({ url: base, method: "POST", body, signal: signal() }))).toEqual({ phase: "before_send", reason: "network" });
      expect(produced.chunks).toBeLessThan(8);
    });

    it("classifies a connection dropped after the last chunk as after_send", async () => {
      const base = await listen(
        createServer((request) => {
          request.resume();
          request.on("end", () => request.socket.destroy());
        }),
      );
      const { body } = streamBody(8);
      expect(await failureOf(client.request({ url: base, method: "POST", body, signal: signal() }))).toEqual({ phase: "after_send", reason: "network" });
    });

    it("fails before sending when the stream is shorter or longer than declared", async () => {
      let completeRequests = 0;
      const base = await listen(
        createServer((request, response) => {
          request.resume();
          request.on("end", () => {
            completeRequests += 1;
            response.end("ok");
          });
        }),
      );
      const short = streamBody(2, { contentLength: 3 * CHUNK_BYTES }).body;
      expect(await failureOf(client.request({ url: base, method: "POST", body: short, signal: signal() }))).toEqual({ phase: "before_send", reason: "network" });
      const long = streamBody(4, { contentLength: 3 * CHUNK_BYTES }).body;
      expect(await failureOf(client.request({ url: base, method: "POST", body: long, signal: signal() }))).toEqual({ phase: "before_send", reason: "network" });
      expect(completeRequests).toBe(0);
    });

    it("sends an empty stream declared as empty", async () => {
      const base = await listen(createServer((request, response) => response.end(request.headers["content-length"])));
      const body: OutboundStreamBody = { stream: (async function* () {})(), contentType: "text/plain", contentLength: 0 };
      expect(await (await client.request({ url: base, method: "POST", body, signal: signal() })).text()).toBe("0");
    });

    it("pulls from the stream only as fast as the upstream reads", async () => {
      const paused = deferred();
      let request: IncomingMessage | undefined;
      let received = 0;
      const base = await listen(
        createServer((incoming, response) => {
          request = incoming;
          incoming.pause();
          paused.resolve();
          incoming.on("data", (chunk: Buffer) => (received += chunk.length));
          incoming.on("end", () => response.end());
        }),
      );
      const total = 512;
      const { body, produced } = streamBody(total);
      const pending = client.request({ url: base, method: "POST", body, signal: signal() });
      await paused.promise;
      await new Promise((resolve) => setTimeout(resolve, 100));
      // 32 MiB in total; socket buffers hold only a fraction while the server reads nothing.
      expect(produced.chunks).toBeLessThan(total);
      request?.resume();
      await (await pending).text();
      expect(received).toBe(total * CHUNK_BYTES);
    });

    it("aborts a running upload on the signal", async () => {
      const controller = new AbortController();
      const base = await listen(createServer((request) => request.once("data", () => controller.abort())));
      const { body } = streamBody(8, { beforeChunk: (index) => (index === 3 ? new Promise((resolve) => setTimeout(resolve, 50)) : Promise.resolve()) });
      expect(await failureOf(client.request({ url: base, method: "POST", body, signal: controller.signal }))).toEqual({ phase: "before_send", reason: "aborted" });
    });
  });
  it("sends HEAD and ends on the bodiless response", async () => {
    const base = await listen(
      createServer((request, response) => {
        response.setHeader("X-Method", request.method ?? "");
        response.setHeader("Content-Length", "42");
        response.end();
      }),
    );
    const response = await client.request({ url: `${base}/file`, method: "HEAD", signal: signal() });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-method")).toBe("HEAD");
    expect(response.headers.get("content-length")).toBe("42");
    expect(await response.text()).toBe("");
  });

  it("connects a pinned request to the given address, on a connection of its own", async () => {
    const connections: string[] = [];
    const server = createServer((_request, response) => response.end("ok"));
    server.on("connection", (socket) => connections.push(socket.remoteAddress ?? ""));
    const base = await listen(server);
    const port = new URL(base).port;
    // The host name does not resolve; only the pinned address can make the request work.
    const url = `http://pinned.invalid:${port}/`;
    for (let index = 0; index < 2; index += 1) {
      const response = await client.send({ url, method: "GET", signal: signal() }, { address: "127.0.0.1", family: 4 });
      expect(await response.text()).toBe("ok");
    }
    expect(connections).toHaveLength(2);
  });
});
