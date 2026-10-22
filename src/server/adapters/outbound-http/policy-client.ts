import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { OUTBOUND_MAX_REDIRECTS } from "../../../shared/defaults.ts";
import type { RefinedErrorCode } from "../../../shared/errors.ts";
import { amberError } from "../../domain/errors.ts";
import { FORBIDDEN_ADDRESS_RANGES, isForbiddenAddress, originOf } from "../../domain/network-policy.ts";
import type { NetworkTargetCheck } from "../../ports/network-target-check.ts";
import {
  OutboundHttpError,
  type OutboundHttpClient,
  type OutboundRequest,
  type OutboundResponse,
} from "../../ports/outbound-http.ts";
import { DirectOutboundHttpClient, type OutboundTransport, type PinnedAddress } from "./direct.ts";

/** Resolves a host name to every address it has, like `dns.lookup(host, { all: true })`. */
export type HostResolver = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

export interface PolicyOutboundHttpClientOptions {
  /**
   * `strict` (server mode): forbidden ranges, allowlist and IP pinning apply to every
   * hop. `permissive` (local mode): no address checks and no pinning, so keep-alive stays;
   * redirect semantics and header stripping are the same in both.
   */
  mode: "strict" | "permissive";
  /** Normalized allowlisted origins (exact `scheme://host[:port]`), read on every request. */
  allowlist?: () => ReadonlySet<string>;
  resolve?: HostResolver;
  /** CIDR ranges to refuse; `FORBIDDEN_ADDRESS_RANGES` unless a test injects its own. */
  forbidden?: readonly string[];
  maxRedirects?: number;
  transport?: OutboundTransport;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** The only request headers a hop to another origin keeps (RFC 9110 §15.4). */
const CROSS_ORIGIN_HEADERS = new Set(["accept", "accept-language", "user-agent", "range"]);

const defaultResolve: HostResolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

/**
 * Invariant: every request to a user-controllable target goes through this single
 * OutboundHttpClient, so a custom URL cannot reach the deployment machine's private
 * network. In strict mode each hop's host is resolved once, every address is checked
 * against the forbidden ranges (skipped only for an allowlisted origin), and the
 * connection is pinned to the first address, so a DNS answer that changes between check
 * and connect cannot redirect it.
 * GET / HEAD follow up to `maxRedirects` redirects, each hop checked again; other methods
 * and `redirect: "manual"` get the 3xx back: a non-GET request may be a paid call, and
 * following its redirect would send it a second time. A hop to another origin keeps
 * only harmless headers, so credentials never travel to a host the caller did not name.
 */
export class PolicyOutboundHttpClient implements OutboundHttpClient, NetworkTargetCheck {
  private readonly options: PolicyOutboundHttpClientOptions;
  private readonly transport: OutboundTransport;
  private readonly resolve: HostResolver;

  constructor(options: PolicyOutboundHttpClientOptions) {
    this.options = options;
    this.transport = options.transport ?? new DirectOutboundHttpClient();
    this.resolve = options.resolve ?? defaultResolve;
  }

  async request(request: OutboundRequest): Promise<OutboundResponse> {
    const maxRedirects = this.options.maxRedirects ?? OUTBOUND_MAX_REDIRECTS;
    const follows = (request.redirect ?? "follow") === "follow" && (request.method === "GET" || request.method === "HEAD");
    let url = parseTarget(request.url);
    let hop: OutboundRequest = request;
    for (let redirects = 0; ; redirects++) {
      const pinned = await this.admit(url, redirects === 0 ? undefined : "network_blocked_by_policy.redirect");
      const response = await this.transport.send({ ...hop, url: url.toString() }, pinned);
      const location = response.headers.get("location");
      if (!follows || !REDIRECT_STATUSES.has(response.status) || location === undefined) {
        return response;
      }
      await discard(response);
      if (redirects >= maxRedirects) {
        throw blocked("network_blocked_by_policy.redirect", `more than ${maxRedirects} redirects`);
      }
      let next: URL;
      try {
        next = parseTarget(new URL(location, url).toString());
      } catch {
        throw blocked("network_blocked_by_policy.redirect", "redirect to an unusable location");
      }
      const headers = originOf(next) === originOf(url) ? hop.headers : crossOriginHeaders(hop.headers);
      const { body: _body, headers: _headers, ...rest } = hop;
      hop = { ...rest, ...(headers === undefined ? {} : { headers }) };
      url = next;
    }
  }

  /** Save-time check of a user-entered endpoint; an unresolvable host is left to request time. */
  async check(target: string): Promise<void> {
    let url: URL;
    try {
      url = parseTarget(target);
    } catch {
      return;
    }
    try {
      await this.admit(url, undefined);
    } catch (error) {
      if (error instanceof OutboundHttpError) {
        return;
      }
      throw error;
    }
  }

  /**
   * Decides where one hop may connect. `refusal` replaces the specific code for hops
   * reached by following a redirect.
   */
  private async admit(url: URL, refusal: RefinedErrorCode | undefined): Promise<PinnedAddress | undefined> {
    if (this.options.mode === "permissive") {
      return undefined;
    }
    const forbidden = this.options.forbidden ?? FORBIDDEN_ADDRESS_RANGES;
    const allowlisted = this.options.allowlist?.().has(originOf(url)) ?? false;
    const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    const literal = isIP(host);
    if (literal !== 0) {
      if (!allowlisted && isForbiddenAddress(host, forbidden)) {
        throw blocked(refusal ?? "network_blocked_by_policy.private_address", "target address is in a forbidden range");
      }
      return { address: host, family: literal as 4 | 6 };
    }
    let addresses: ReadonlyArray<{ address: string; family: number }>;
    try {
      addresses = await this.resolve(host);
    } catch (error) {
      throw new OutboundHttpError("before_send", "network", { cause: error });
    }
    const first = addresses[0];
    if (first === undefined) {
      throw new OutboundHttpError("before_send", "network");
    }
    if (!allowlisted && addresses.some((entry) => isForbiddenAddress(entry.address, forbidden))) {
      throw blocked(refusal ?? "network_blocked_by_policy.dns_rebinding", "target host resolves to a forbidden range");
    }
    return { address: first.address, family: first.family === 6 ? 6 : 4 };
  }
}

function parseTarget(text: string): URL {
  const url = new URL(text);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("only http and https URLs are supported");
  }
  return url;
}

function blocked(code: RefinedErrorCode, message: string) {
  return amberError("network_blocked_by_policy", message, { code });
}

function crossOriginHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> | undefined {
  if (headers === undefined) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(headers).filter(([name]) => CROSS_ORIGIN_HEADERS.has(name.toLowerCase())));
}

/** Drops a redirect's body without reading more than its first chunk; its connection is not reused. */
async function discard(response: OutboundResponse): Promise<void> {
  const iterator = response.body[Symbol.asyncIterator]();
  try {
    const first = await iterator.next();
    if (first.done !== true) {
      await iterator.return?.();
    }
  } catch {
    // A broken redirect body does not matter; the next hop is a new request.
  }
}
