import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUBTITLE_FONT_MAX_BYTES } from "../../../src/shared/defaults.ts";
import { ApiClient } from "../../../src/web/api/client.ts";
import { ApiProvider, createQueryClient } from "../../../src/web/api/context.tsx";
import { loadSubtitleFont, resetSubtitleFont, SUBTITLE_FONT_FAMILY, useSubtitleFontFallback } from "../../../src/web/player/subtitle-font.ts";

/** A FontFace stand-in recording what was registered; jsdom has no font loading. */
function fakeFonts() {
  const added: Array<{ family: string; source: ArrayBuffer }> = [];
  class FakeFontFace {
    readonly family: string;
    readonly source: ArrayBuffer;
    constructor(family: string, source: ArrayBuffer) {
      this.family = family;
      this.source = source;
    }
    load(): Promise<this> {
      return Promise.resolve(this);
    }
  }
  vi.stubGlobal("FontFace", FakeFontFace);
  Object.defineProperty(document, "fonts", { configurable: true, value: { add: (face: FakeFontFace) => added.push({ family: face.family, source: face.source }) } });
  return added;
}

function fontServer(answers: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const answer = answers.shift();
    return answer === undefined ? new Response(new Uint8Array([7]), { headers: { "content-type": "font/otf" } }) : answer();
  });
  return calls;
}

const client = new ApiClient({ baseUrl: "" }, "local");
const wrapper = (props: { children: ReactNode }) => createElement(ApiProvider, { client, queryClient: createQueryClient(), children: props.children });

beforeEach(() => resetSubtitleFont());
afterEach(() => {
  Reflect.deleteProperty(document, "fonts");
});

describe("subtitle font", () => {
  it("is fetched only once subtitles are first switched on, then registered once per page", async () => {
    const added = fakeFonts();
    const calls = fontServer([]);
    const { result, rerender } = renderHook((props: { on: boolean }) => useSubtitleFontFallback(props.on), { wrapper, initialProps: { on: false } });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(calls).toEqual([]);
    rerender({ on: true });
    await waitFor(() => expect(added).toHaveLength(1));
    expect(calls.map((call) => call.url)).toEqual(["/api/fonts/subtitle"]);
    expect((calls[0]?.init.headers as Record<string, string>)["accept"]).toBe("font/otf");
    expect(added[0]?.family).toBe(SUBTITLE_FONT_FAMILY);
    expect(result.current).toBe(false);
    rerender({ on: false });
    rerender({ on: true });
    expect(await loadSubtitleFont(client)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("falls back after a failure and tries again next time", async () => {
    const added = fakeFonts();
    const calls = fontServer([() => new Response("missing", { status: 404 })]);
    const { result, rerender } = renderHook((props: { on: boolean }) => useSubtitleFontFallback(props.on), { wrapper, initialProps: { on: true } });
    await waitFor(() => expect(result.current).toBe(true));
    expect(added).toEqual([]);
    rerender({ on: false });
    rerender({ on: true });
    await waitFor(() => expect(result.current).toBe(false));
    expect(calls).toHaveLength(2);
    expect(added).toHaveLength(1);
  });

  it("falls back without a FontFace API and refuses a font over SUBTITLE_FONT_MAX_BYTES", async () => {
    const calls = fontServer([]);
    expect(await loadSubtitleFont(client)).toBe(false);
    expect(calls).toEqual([]);
    fakeFonts();
    fontServer([() => new Response(new Uint8Array([1]), { headers: { "content-type": "font/otf", "content-length": String(SUBTITLE_FONT_MAX_BYTES + 1) } })]);
    expect(await loadSubtitleFont(client)).toBe(false);
  });
});
