import { createServer, type IncomingHttpHeaders, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PolicyOutboundHttpClient, type HostResolver } from "../../../../src/server/adapters/outbound-http/policy-client.ts";
import { isAmberError } from "../../../../src/server/domain/errors.ts";
import { FORBIDDEN_ADDRESS_RANGES } from "../../../../src/server/domain/network-policy.ts";
import { OutboundHttpError, type OutboundRequest } from "../../../../src/server/ports/outbound-http.ts";

// Every request goes to servers on 127.0.0.1 / 127.0.0.2 started by the test; host names are
// answered by a stub resolver, so nothing leaves the machine.
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

interface TestServer {
  port: number;
  /** Requests received: method, path and headers. */
  received: Array<{ method: string; path: string; headers: IncomingHttpHeaders }>;
  connections: number;
}

async function serve(host: "127.0.0.1" | "127.0.0.2", handler: RequestListener, port = 0): Promise<TestServer> {
  const state: TestServer = { port: 0, received: [], connections: 0 };
  const server = createServer((request, response) => {
    state.received.push({ method: request.method ?? "", path: request.url ?? "", headers: request.headers });
    handler(request, response);
  });
  server.on("connection", () => (state.connections += 1));
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  state.port = (server.address() as AddressInfo).port;
  return state;
}

const ok: RequestListener = (_request, response) => response.end("ok");

/** Host name → addresses; a function value answers per call. */
function stubResolver(table: Record<string, string | (() => string)>): HostResolver & { calls: string[] } {
  const calls: string[] = [];
  const resolve = async (hostname: string) => {
    calls.push(hostname);
    const entry = table[hostname];
    if (entry === undefined) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    }
    const address = typeof entry === "function" ? entry() : entry;
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  };
  return Object.assign(resolve, { calls });
}

/** The forbidden address ranges, except that 127.0.0.1 counts as public and only 127.0.0.2 of loopback is forbidden. */
const TEST_RANGES = [...FORBIDDEN_ADDRESS_RANGES.filter((range) => range !== "127.0.0.0/8"), "127.0.0.2/32"];

const signal = () => new AbortController().signal;
const get = (url: string, extra: Partial<OutboundRequest> = {}): OutboundRequest => ({ url, method: "GET", signal: signal(), ...extra });

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (isAmberError(error)) return error.appError.code;
    throw error;
  }
  throw new Error("request unexpectedly succeeded");
}

describe("PolicyOutboundHttpClient (strict)", () => {
  it("refuses metadata and private literals, a privately resolving host, redirects inward and DNS rebinding with their refined codes", async () => {
    const internal = await serve("127.0.0.2", ok);
    let answers = 0;
    const publicServer = await serve("127.0.0.1", (request, response) => {
      response.statusCode = 302;
      response.setHeader("Location", request.url === "/to-literal" ? "http://10.0.0.5/" : `http://internal.test:${internal.port}/`);
      response.end();
    });
    const resolve = stubResolver({
      "private.test": "10.0.0.5",
      "public.test": "127.0.0.1",
      "internal.test": "127.0.0.2",
      // First answer public, any later one internal: the classic rebinding window.
      "rebind.test": () => (answers++ === 0 ? "127.0.0.1" : "127.0.0.2"),
    });
    const client = new PolicyOutboundHttpClient({ mode: "strict", resolve, forbidden: TEST_RANGES });

    expect(await codeOf(client.request(get("http://169.254.169.254/latest/meta-data/")))).toBe("network_blocked_by_policy.private_address");
    expect(await codeOf(client.request(get("http://10.0.0.5/v1")))).toBe("network_blocked_by_policy.private_address");
    expect(await codeOf(client.request(get("http://private.test/v1")))).toBe("network_blocked_by_policy.dns_rebinding");
    expect(await codeOf(client.request(get(`http://public.test:${publicServer.port}/to-literal`)))).toBe("network_blocked_by_policy.redirect");
    expect(await codeOf(client.request(get(`http://public.test:${publicServer.port}/to-host`)))).toBe("network_blocked_by_policy.redirect");
    expect(internal.received).toHaveLength(0);

    // Fifth case: the host is resolved once and the connection is pinned to that answer, so
    // a different answer at connect time cannot divert it to the internal server.
    const rebindTarget = await serve("127.0.0.1", ok);
    const rebindInternal = await serve("127.0.0.2", ok);
    expect(rebindTarget.port).not.toBe(rebindInternal.port);
    const response = await client.request(get(`http://rebind.test:${rebindTarget.port}/`));
    expect(await response.text()).toBe("ok");
    expect(resolve.calls.filter((host) => host === "rebind.test")).toHaveLength(1);
    expect(rebindTarget.received).toHaveLength(1);
    expect(rebindInternal.received).toHaveLength(0);
  });

  it("refuses a host when any of its addresses is forbidden", async () => {
    const resolve: HostResolver = async () => [{ address: "93.184.215.14", family: 4 }, { address: "::ffff:10.1.2.3", family: 6 }];
    const client = new PolicyOutboundHttpClient({ mode: "strict", resolve });
    expect(await codeOf(client.request(get("https://mixed.test/")))).toBe("network_blocked_by_policy.dns_rebinding");
  });

  it("admits an allowlisted exact origin to a forbidden address, still pinned", async () => {
    const internal = await serve("127.0.0.2", ok);
    const resolve = stubResolver({ "relay.lan": "127.0.0.2" });
    const allowlist = new Set([`http://relay.lan:${internal.port}`]);
    const client = new PolicyOutboundHttpClient({ mode: "strict", resolve, forbidden: TEST_RANGES, allowlist: () => allowlist });
    expect(await (await client.request(get(`http://relay.lan:${internal.port}/v1/models`))).text()).toBe("ok");
    // Same host, another port: a different origin, so not allowlisted.
    expect(await codeOf(client.request(get(`http://relay.lan:${internal.port + 1}/`)))).toBe("network_blocked_by_policy.dns_rebinding");
    // A literal forbidden address passes only through its own exact origin.
    allowlist.add(`http://127.0.0.2:${internal.port}`);
    expect(await (await client.request(get(`http://127.0.0.2:${internal.port}/`))).text()).toBe("ok");
    expect(internal.received).toHaveLength(2);
  });

  it("never reuses a pinned connection after the allowlist and DNS change", async () => {
    // Both servers listen on the same port number so only the address tells them apart.
    const internal = await serve("127.0.0.2", ok);
    const port = internal.port;
    const sameport = await serve("127.0.0.1", ok, port);

    let address = "127.0.0.2";
    const resolve = stubResolver({ "relay.lan": () => address });
    const allowlist = new Set([`http://relay.lan:${port}`]);
    const client = new PolicyOutboundHttpClient({ mode: "strict", resolve, forbidden: TEST_RANGES, allowlist: () => allowlist });

    expect(await (await client.request(get(`http://relay.lan:${port}/first`))).text()).toBe("ok");
    expect(internal.received.map((entry) => entry.path)).toEqual(["/first"]);

    allowlist.clear();
    address = "127.0.0.1";
    expect(await (await client.request(get(`http://relay.lan:${port}/second`))).text()).toBe("ok");
    expect(internal.received.map((entry) => entry.path)).toEqual(["/first"]);
    expect(sameport.received.map((entry) => entry.path)).toEqual(["/second"]);
    expect(internal.connections + sameport.connections).toBe(2);

    // And with the DNS answer back on the forbidden address, nothing reaches it any more.
    address = "127.0.0.2";
    expect(await codeOf(client.request(get(`http://relay.lan:${port}/third`)))).toBe("network_blocked_by_policy.dns_rebinding");
    expect(internal.received).toHaveLength(1);
  });

  it("treats an unresolvable host as a transport failure before sending", async () => {
    const client = new PolicyOutboundHttpClient({ mode: "strict", resolve: stubResolver({}) });
    const failure = await client.request(get("https://nowhere.test/")).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OutboundHttpError);
    expect(failure).toMatchObject({ phase: "before_send", reason: "network" });
  });

  it("checks endpoints at save time without sending anything", async () => {
    const client = new PolicyOutboundHttpClient({ mode: "strict", resolve: stubResolver({ "private.test": "10.0.0.5", "public.test": "93.184.215.14" }) });
    expect(await codeOf(client.check("http://169.254.169.254"))).toBe("network_blocked_by_policy.private_address");
    expect(await codeOf(client.check("https://[fd00:ec2::254]/"))).toBe("network_blocked_by_policy.private_address");
    expect(await codeOf(client.check("https://private.test/v1"))).toBe("network_blocked_by_policy.dns_rebinding");
    await expect(client.check("https://public.test/v1")).resolves.toBeUndefined();
    // Resolution failures are left to request time.
    await expect(client.check("https://unknown.test/v1")).resolves.toBeUndefined();
  });
});

describe("PolicyOutboundHttpClient redirects", () => {
  const credentials = {
    Authorization: "Bearer <placeholder>",
    "x-api-key": "<placeholder>",
    "xi-api-key": "<placeholder>",
    Cookie: "a=<placeholder>",
    Accept: "application/json",
    "Accept-Language": "zh-CN",
    "User-Agent": "amber-test",
    Range: "bytes=0-9",
  };

  async function chain() {
    const target = await serve("127.0.0.1", ok);
    const origin = await serve("127.0.0.1", (request, response) => {
      response.statusCode = request.url === "/see-other" ? 303 : 302;
      response.setHeader("Location", request.url === "/same" ? "/landed" : `http://127.0.0.1:${target.port}/landed`);
      response.end("moved");
    });
    return { target, origin };
  }

  const permissive = () => new PolicyOutboundHttpClient({ mode: "permissive" });

  it("forwards only harmless headers to another origin and everything within the same origin", async () => {
    const { target, origin } = await chain();
    for (const client of [permissive(), new PolicyOutboundHttpClient({ mode: "strict", forbidden: TEST_RANGES })]) {
      target.received.length = 0;
      origin.received.length = 0;
      expect(await (await client.request(get(`http://127.0.0.1:${origin.port}/cross`, { headers: credentials }))).text()).toBe("ok");
      const crossed = target.received[0]?.headers ?? {};
      for (const name of ["authorization", "x-api-key", "xi-api-key", "cookie"]) expect(crossed[name], name).toBeUndefined();
      expect(crossed).toMatchObject({ accept: "application/json", "accept-language": "zh-CN", "user-agent": "amber-test", range: "bytes=0-9" });

      expect(await (await client.request(get(`http://127.0.0.1:${origin.port}/same`, { headers: credentials }))).text()).toBe("ok");
      const same = origin.received.find((entry) => entry.path === "/landed")?.headers ?? {};
      expect(same).toMatchObject({ authorization: "Bearer <placeholder>", "x-api-key": "<placeholder>", cookie: "a=<placeholder>" });
    }
  });

  it("follows 303 with GET, keeps HEAD a HEAD and returns 3xx of other methods untouched", async () => {
    const { target, origin } = await chain();
    const client = permissive();
    await (await client.request(get(`http://127.0.0.1:${origin.port}/see-other`))).text();
    await (await client.request({ url: `http://127.0.0.1:${origin.port}/see-other`, method: "HEAD", signal: signal() })).text();
    expect(target.received.map((entry) => entry.method)).toEqual(["GET", "HEAD"]);

    const posted = await client.request({ url: `http://127.0.0.1:${origin.port}/cross`, method: "POST", body: "{}", signal: signal() });
    expect(posted.status).toBe(302);
    expect(await posted.text()).toBe("moved");
    expect(target.received).toHaveLength(2);
  });

  it("returns the 3xx with redirect: manual, still checking that hop", async () => {
    const { target, origin } = await chain();
    const response = await permissive().request(get(`http://127.0.0.1:${origin.port}/cross`, { redirect: "manual" }));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`http://127.0.0.1:${target.port}/landed`);
    expect(target.received).toHaveLength(0);
    const strict = new PolicyOutboundHttpClient({ mode: "strict" });
    expect(await codeOf(strict.request(get(`http://127.0.0.1:${origin.port}/cross`, { redirect: "manual" })))).toBe("network_blocked_by_policy.private_address");
  });

  it("follows at most maxRedirects redirects", async () => {
    const loop = await serve("127.0.0.1", (request, response) => {
      const step = Number((request.url ?? "/0").slice(1));
      if (step >= 2) {
        response.end(`landed after ${step}`);
        return;
      }
      response.statusCode = 301;
      response.setHeader("Location", `/${step + 1}`);
      response.end();
    });
    expect(await (await new PolicyOutboundHttpClient({ mode: "permissive", maxRedirects: 2 }).request(get(`http://127.0.0.1:${loop.port}/0`))).text()).toBe(
      "landed after 2",
    );
    expect(await codeOf(new PolicyOutboundHttpClient({ mode: "permissive", maxRedirects: 1 }).request(get(`http://127.0.0.1:${loop.port}/0`)))).toBe(
      "network_blocked_by_policy.redirect",
    );
  });

  it("lets local mode reach loopback without resolving through the policy", async () => {
    const local = await serve("127.0.0.1", ok);
    const resolve = stubResolver({});
    const client = new PolicyOutboundHttpClient({ mode: "permissive", resolve });
    expect(await (await client.request(get(`http://localhost:${local.port}/`))).text()).toBe("ok");
    await expect(client.check("http://169.254.169.254")).resolves.toBeUndefined();
    expect(resolve.calls).toEqual([]);
  });
});
