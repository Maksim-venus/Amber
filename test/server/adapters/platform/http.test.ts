import { describe, expect, it } from "vitest";
import { BROWSER_USER_AGENT, platformGet, platformGetJson } from "../../../../src/server/adapters/platform/http.ts";
import { isAmberError } from "../../../../src/server/domain/errors.ts";
import { OutboundHttpError } from "../../../../src/server/ports/outbound-http.ts";
import { PLATFORM_METADATA_TIMEOUT_MS } from "../../../../src/shared/defaults.ts";
import { ScriptedHttp, signal, type ScriptedResponse } from "../../../fixtures/platform/scripted-io.ts";

const PAGELIST = "https://api.bilibili.com/x/player/pagelist?bvid=BV1xx411c7mD";

async function classOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isAmberError(error)) {
      return error.appError.class;
    }
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("platformGetJson", () => {
  it("sends a GET with a browser identity, the caller's headers and the metadata timeout", async () => {
    const http = new ScriptedHttp(() => ({ body: { code: 0 } }));
    expect(await platformGetJson(http, { url: PAGELIST, headers: { Referer: "https://www.bilibili.com/", Cookie: "a=<placeholder>" }, signal: signal() })).toEqual({
      code: 0,
    });
    expect(http.requests[0]).toMatchObject({
      url: PAGELIST,
      method: "GET",
      headers: { "User-Agent": BROWSER_USER_AGENT, Referer: "https://www.bilibili.com/", Cookie: "a=<placeholder>" },
      timeoutMs: PLATFORM_METADATA_TIMEOUT_MS,
    });
    expect(http.requests[0]?.redirect).toBeUndefined();
  });

  it("maps risk-control statuses, other HTTP errors and non-JSON bodies to source classes", async () => {
    const cases: Array<[ScriptedResponse, string]> = [
      [{ status: 412, body: "" }, "platform_blocked"],
      [{ status: 429, body: "" }, "platform_blocked"],
      [{ status: 404, body: "{}" }, "source_unreachable"],
      [{ status: 503, body: "{}" }, "source_unreachable"],
      [{ status: 302, body: "", headers: { Location: "https://example.com/" } }, "source_unreachable"],
      [{ status: 200, body: "<html><body>captcha</body></html>" }, "source_html_error_page"],
    ];
    for (const [answer, expected] of cases) {
      expect(await classOf(platformGetJson(new ScriptedHttp(() => answer), { url: PAGELIST, signal: signal() })), JSON.stringify(answer)).toBe(expected);
    }
  });

  it("maps transport failures to source_unreachable but lets an abort through", async () => {
    for (const reason of ["network", "timeout"] as const) {
      const http = new ScriptedHttp(() => new OutboundHttpError("before_send", reason));
      expect(await classOf(platformGetJson(http, { url: PAGELIST, signal: signal() }))).toBe("source_unreachable");
    }
    const aborted = new ScriptedHttp(() => new OutboundHttpError("after_send", "aborted"));
    await expect(platformGetJson(aborted, { url: PAGELIST, signal: signal() })).rejects.toBeInstanceOf(OutboundHttpError);
  });
});

describe("platformGet", () => {
  it("hands back redirects and error statuses as responses", async () => {
    const http = new ScriptedHttp(() => ({ status: 302, headers: { Location: "https://www.bilibili.com/video/BV1xx411c7mD" } }));
    const response = await platformGet(http, { url: "https://b23.tv/abc", signal: signal() });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://www.bilibili.com/video/BV1xx411c7mD");
    expect(http.requests[0]?.headers).toEqual({ "User-Agent": BROWSER_USER_AGENT });
    // The caller walks the chain itself; the client must not follow it.
    expect(http.requests[0]?.redirect).toBe("manual");
  });
});
