import { describe, expect, it } from "vitest";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import {
  canonicalPlatformCookies,
  cookieDomainMatches,
  cookieHeaderFor,
  formatNetscapeCookies,
  parseNetscapeCookies,
  parseSetCookie,
  type NetscapeCookie,
} from "../../../src/server/domain/platform-cookie.ts";

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;
const DOMAINS = ["bilibili.com"];

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (isAmberError(error)) {
      return error.appError.code;
    }
    throw error;
  }
  throw new Error("expected a failure");
}

const NETSCAPE = [
  "# Netscape HTTP Cookie File",
  "# comment",
  "",
  `.bilibili.com\tTRUE\t/\tTRUE\t${NOW_S + 3600}\tsession_a\t<placeholder>`,
  `#HttpOnly_www.bilibili.com\tFALSE\t/\tFALSE\t0\tsession_b\t<placeholder>`,
  `.example.com\tTRUE\t/\tTRUE\t${NOW_S + 3600}\tforeign\t<placeholder>`,
].join("\n");

describe("cookieDomainMatches", () => {
  it("accepts the domain itself and its subdomains, with or without a leading dot, in any case", () => {
    expect(cookieDomainMatches(".bilibili.com", DOMAINS)).toBe(true);
    expect(cookieDomainMatches("WWW.Bilibili.com", DOMAINS)).toBe(true);
    expect(cookieDomainMatches("bilibili.com", [".bilibili.com"])).toBe(true);
  });

  it("rejects look-alike domains", () => {
    expect(cookieDomainMatches("evilbilibili.com", DOMAINS)).toBe(false);
    expect(cookieDomainMatches("bilibili.com.example.com", DOMAINS)).toBe(false);
  });
});

describe("canonicalPlatformCookies", () => {
  it("keeps only the platform's cookies of a cookies.txt, preserving their fields", () => {
    const text = canonicalPlatformCookies(NETSCAPE, DOMAINS, NOW_MS);
    expect(text.startsWith("# Netscape HTTP Cookie File\n")).toBe(true);
    expect(parseNetscapeCookies(text)).toEqual([
      { domain: ".bilibili.com", includeSubdomains: true, path: "/", secure: true, expires: NOW_S + 3600, name: "session_a", value: "<placeholder>", httpOnly: false },
      { domain: "www.bilibili.com", includeSubdomains: false, path: "/", secure: false, expires: 0, name: "session_b", value: "<placeholder>", httpOnly: true },
    ]);
  });

  it("drops a leading BOM and accepts CRLF line ends", () => {
    const text = canonicalPlatformCookies(`\uFEFF${NETSCAPE.replaceAll("\n", "\r\n")}`, DOMAINS, NOW_MS);
    expect(parseNetscapeCookies(text).map((cookie) => cookie.name)).toEqual(["session_a", "session_b"]);
  });

  it("converts a Cookie header, with or without its prefix, onto the first platform domain with a 400-day expiry", () => {
    for (const input of ["Cookie: session_a=<placeholder>; session_b=<placeholder>", "session_a=<placeholder>;session_b=<placeholder>;"]) {
      expect(parseNetscapeCookies(canonicalPlatformCookies(input, DOMAINS, NOW_MS))).toEqual(
        ["session_a", "session_b"].map((name) => ({
          domain: ".bilibili.com",
          includeSubdomains: true,
          path: "/",
          secure: true,
          expires: NOW_S + 400 * 24 * 3600,
          name,
          value: "<placeholder>",
          httpOnly: false,
        })),
      );
    }
  });

  it("answers invalid_request.cookie_format for malformed input or when nothing of the platform is left", () => {
    expect(codeOf(() => canonicalPlatformCookies("", DOMAINS, NOW_MS))).toBe("invalid_request.cookie_format");
    expect(codeOf(() => canonicalPlatformCookies("=<placeholder>", DOMAINS, NOW_MS))).toBe("invalid_request.cookie_format");
    expect(codeOf(() => canonicalPlatformCookies(`.example.com\tTRUE\t/\tTRUE\t0\tforeign\t<placeholder>`, DOMAINS, NOW_MS))).toBe(
      "invalid_request.cookie_format",
    );
    expect(codeOf(() => canonicalPlatformCookies("# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE", DOMAINS, NOW_MS))).toBe(
      "invalid_request.cookie_format",
    );
    expect(codeOf(() => canonicalPlatformCookies(`.bilibili.com\tTRUE\t/\tTRUE\tsoon\tname\t<placeholder>`, DOMAINS, NOW_MS))).toBe(
      "invalid_request.cookie_format",
    );
  });

  it("needs the platform to declare its cookie domains", () => {
    expect(() => canonicalPlatformCookies(NETSCAPE, [], NOW_MS)).toThrow(TypeError);
  });
});

describe("parseSetCookie", () => {
  const HOST = "passport.bilibili.com";

  it("maps a domain cookie with Expires, Path, Secure and HttpOnly onto a cookies.txt entry", () => {
    const expires = new Date((NOW_S + 3600) * 1000).toUTCString();
    expect(parseSetCookie(`session_a=<placeholder>; Path=/; Domain=.bilibili.com; Expires=${expires}; Secure; HttpOnly`, HOST, NOW_MS)).toEqual({
      domain: ".bilibili.com",
      includeSubdomains: true,
      path: "/",
      secure: true,
      expires: NOW_S + 3600,
      name: "session_a",
      value: "<placeholder>",
      httpOnly: true,
    });
  });

  it("keeps a host-only cookie on the request host and a cookie without expiry as a session cookie", () => {
    expect(parseSetCookie("session_b=<placeholder>", "PASSPORT.bilibili.com", NOW_MS)).toMatchObject({
      domain: HOST,
      includeSubdomains: false,
      path: "/",
      expires: 0,
      secure: false,
      httpOnly: false,
    });
  });

  it("lets Max-Age win over Expires", () => {
    const expires = new Date((NOW_S + 10) * 1000).toUTCString();
    expect(parseSetCookie(`a=<placeholder>; Expires=${expires}; Max-Age=7200`, HOST, NOW_MS)?.expires).toBe(NOW_S + 7200);
  });

  it("drops expired, nameless and foreign-domain cookies", () => {
    expect(parseSetCookie("a=<placeholder>; Max-Age=0", HOST, NOW_MS)).toBeUndefined();
    expect(parseSetCookie(`a=<placeholder>; Expires=${new Date(NOW_MS - 1000).toUTCString()}`, HOST, NOW_MS)).toBeUndefined();
    expect(parseSetCookie("=<placeholder>", HOST, NOW_MS)).toBeUndefined();
    expect(parseSetCookie("novalue", HOST, NOW_MS)).toBeUndefined();
    expect(parseSetCookie("a=<placeholder>; Domain=example.com", HOST, NOW_MS)).toBeUndefined();
  });
});

describe("formatNetscapeCookies", () => {
  it("round-trips through parseNetscapeCookies", () => {
    const cookies = parseNetscapeCookies(NETSCAPE);
    expect(parseNetscapeCookies(formatNetscapeCookies(cookies))).toEqual(cookies);
  });
});

describe("cookieHeaderFor", () => {
  const cookie = (overrides: Partial<NetscapeCookie>): NetscapeCookie => ({
    domain: ".bilibili.com",
    includeSubdomains: true,
    path: "/",
    secure: true,
    expires: NOW_S + 60,
    name: "a",
    value: "<placeholder>",
    httpOnly: false,
    ...overrides,
  });

  it("sends matching, unexpired cookies; session cookies always count", () => {
    const cookies = [
      cookie({ name: "a" }),
      cookie({ name: "session", expires: 0 }),
      cookie({ name: "expired", expires: NOW_S - 1 }),
      cookie({ name: "exact", domain: "api.bilibili.com", includeSubdomains: false }),
      cookie({ name: "other", domain: ".example.com" }),
    ];
    expect(cookieHeaderFor(cookies, "api.bilibili.com", NOW_MS)).toBe("a=<placeholder>; session=<placeholder>; exact=<placeholder>");
    expect(cookieHeaderFor(cookies, "www.bilibili.com", NOW_MS)).toBe("a=<placeholder>; session=<placeholder>");
    expect(cookieHeaderFor(cookies, "BILIBILI.com", NOW_MS)).toBe("a=<placeholder>; session=<placeholder>");
  });

  it("does not send a host-only cookie to subdomains", () => {
    expect(cookieHeaderFor([cookie({ domain: "bilibili.com", includeSubdomains: false })], "api.bilibili.com", NOW_MS)).toBe("");
  });
});
