import { amberError } from "./errors.ts";

/** One cookie of a Netscape cookies.txt file. */
export interface NetscapeCookie {
  domain: string;
  includeSubdomains: boolean;
  path: string;
  secure: boolean;
  /** Unix seconds; 0 marks a session cookie. */
  expires: number;
  name: string;
  value: string;
  httpOnly: boolean;
}

const HEADER = "# Netscape HTTP Cookie File";
const HTTP_ONLY_PREFIX = "#HttpOnly_";
/** Cookies converted from a pasted `Cookie:` header carry no expiry; they are kept this long. */
const CONVERTED_COOKIE_LIFETIME_S = 400 * 24 * 3600;

function formatError(message: string): Error {
  return amberError("invalid_request", message, { code: "invalid_request.cookie_format" });
}

function bareDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^\./, "");
}

/** Whether `domain` is one of `allowed` or a subdomain of one. */
export function cookieDomainMatches(domain: string, allowed: readonly string[]): boolean {
  const bare = bareDomain(domain);
  return allowed.some((candidate) => {
    const root = bareDomain(candidate);
    return bare === root || bare.endsWith(`.${root}`);
  });
}

function parseNetscapeLines(text: string): NetscapeCookie[] {
  const cookies: NetscapeCookie[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    let line = raw.trim();
    let httpOnly = false;
    if (line.startsWith(HTTP_ONLY_PREFIX)) {
      httpOnly = true;
      line = line.slice(HTTP_ONLY_PREFIX.length);
    } else if (line === "" || line.startsWith("#")) {
      continue;
    }
    const fields = line.split("\t");
    if (fields.length !== 7) {
      throw formatError("a cookies.txt line does not have seven tab-separated fields");
    }
    const [domain, includeSubdomains, path, secure, expires, name, value] = fields as [string, string, string, string, string, string, string];
    const expiresS = Number(expires);
    if (domain === "" || name === "" || !Number.isFinite(expiresS)) {
      throw formatError("a cookies.txt line is malformed");
    }
    cookies.push({
      domain,
      includeSubdomains: includeSubdomains.toUpperCase() === "TRUE",
      path: path === "" ? "/" : path,
      secure: secure.toUpperCase() === "TRUE",
      expires: Math.trunc(expiresS),
      name,
      value,
      httpOnly,
    });
  }
  return cookies;
}

function parseCookieHeader(text: string, domain: string, nowMs: number): NetscapeCookie[] {
  const header = text.trim().replace(/^cookie:\s*/i, "");
  const expires = Math.floor(nowMs / 1000) + CONVERTED_COOKIE_LIFETIME_S;
  const cookies: NetscapeCookie[] = [];
  for (const pair of header.split(";")) {
    const trimmed = pair.trim();
    if (trimmed === "") {
      continue;
    }
    const equals = trimmed.indexOf("=");
    if (equals <= 0) {
      throw formatError("a Cookie header pair has no name");
    }
    cookies.push({
      domain: `.${bareDomain(domain)}`,
      includeSubdomains: true,
      path: "/",
      secure: true,
      expires,
      name: trimmed.slice(0, equals).trim(),
      value: trimmed.slice(equals + 1).trim(),
      httpOnly: false,
    });
  }
  return cookies;
}

function looksLikeNetscape(text: string): boolean {
  return text.split(/\r\n|\r|\n/).some((line) => line.startsWith(HEADER) || line.split("\t").length === 7);
}

/**
 * Normalizes pasted cookies to the canonical Netscape cookies.txt text:
 * a cookies.txt is parsed as is; a `Cookie:` header (with or without the prefix) is
 * converted onto the platform's first cookie domain. Only cookies of `domains` survive;
 * an input with nothing left is `invalid_request.cookie_format`.
 */
export function canonicalPlatformCookies(input: string, domains: readonly string[], nowMs: number): string {
  if (domains.length === 0) {
    throw new TypeError("a platform must declare its cookie domains");
  }
  const text = input.replace(/^\uFEFF/, "");
  const cookies = looksLikeNetscape(text) ? parseNetscapeLines(text) : parseCookieHeader(text, domains[0] as string, nowMs);
  const kept = cookies.filter((cookie) => cookieDomainMatches(cookie.domain, domains));
  if (kept.length === 0) {
    throw formatError("no cookie of the platform's domains was found");
  }
  return formatNetscapeCookies(kept);
}

export function parseNetscapeCookies(text: string): NetscapeCookie[] {
  return parseNetscapeLines(text);
}

export function formatNetscapeCookies(cookies: readonly NetscapeCookie[]): string {
  const lines = cookies.map((cookie) =>
    [
      `${cookie.httpOnly ? HTTP_ONLY_PREFIX : ""}${cookie.domain}`,
      cookie.includeSubdomains ? "TRUE" : "FALSE",
      cookie.path,
      cookie.secure ? "TRUE" : "FALSE",
      String(cookie.expires),
      cookie.name,
      cookie.value,
    ].join("\t"),
  );
  return `${HEADER}\n${lines.join("\n")}\n`;
}

/**
 * One `Set-Cookie` response header from `requestHost` as a cookies.txt entry (RFC 6265
 * §5.2–5.3): `Max-Age` wins over `Expires`, neither makes a session cookie (`expires` 0);
 * without `Domain` the cookie is host-only. A missing `Path` becomes `/` rather than the
 * request's directory, which is what a stored login needs. Answers `undefined` for a
 * nameless or already expired cookie and for a `Domain` the host does not belong to.
 */
export function parseSetCookie(header: string, requestHost: string, nowMs: number): NetscapeCookie | undefined {
  const [pair = "", ...attributes] = header.split(";");
  const equals = pair.indexOf("=");
  const name = equals < 0 ? "" : pair.slice(0, equals).trim();
  if (name === "") {
    return undefined;
  }
  const host = requestHost.toLowerCase();
  const cookie: NetscapeCookie = {
    domain: host,
    includeSubdomains: false,
    path: "/",
    secure: false,
    expires: 0,
    name,
    value: pair.slice(equals + 1).trim(),
    httpOnly: false,
  };
  let maxAge: number | undefined;
  let expiresMs: number | undefined;
  for (const attribute of attributes) {
    const separator = attribute.indexOf("=");
    const key = (separator < 0 ? attribute : attribute.slice(0, separator)).trim().toLowerCase();
    const value = separator < 0 ? "" : attribute.slice(separator + 1).trim();
    if (key === "domain" && value !== "") {
      const domain = bareDomain(value);
      if (!cookieDomainMatches(host, [domain])) {
        return undefined;
      }
      cookie.domain = `.${domain}`;
      cookie.includeSubdomains = true;
    } else if (key === "path" && value.startsWith("/")) {
      cookie.path = value;
    } else if (key === "secure") {
      cookie.secure = true;
    } else if (key === "httponly") {
      cookie.httpOnly = true;
    } else if (key === "max-age" && /^-?\d+$/.test(value)) {
      maxAge = Number(value);
    } else if (key === "expires") {
      const parsed = Date.parse(value);
      expiresMs = Number.isNaN(parsed) ? undefined : parsed;
    }
  }
  const lapsesAtMs = maxAge !== undefined ? nowMs + maxAge * 1000 : expiresMs;
  if (lapsesAtMs !== undefined) {
    if (lapsesAtMs <= nowMs) {
      return undefined;
    }
    cookie.expires = Math.floor(lapsesAtMs / 1000);
  }
  return cookie;
}

/**
 * The `Cookie` request header a browser would send to `host` over HTTPS: matching domain,
 * not expired at `nowMs` (session cookies always count).
 */
export function cookieHeaderFor(cookies: readonly NetscapeCookie[], host: string, nowMs: number): string {
  const target = host.toLowerCase();
  return cookies
    .filter((cookie) => {
      const domain = bareDomain(cookie.domain);
      const domainMatch = target === domain || ((cookie.includeSubdomains || cookie.domain.startsWith(".")) && target.endsWith(`.${domain}`));
      return domainMatch && (cookie.expires === 0 || cookie.expires * 1000 > nowMs);
    })
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}
