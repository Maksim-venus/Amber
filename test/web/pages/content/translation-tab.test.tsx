import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { BREAKPOINT_DRAWER_PX } from "../../../../src/shared/defaults.ts";
import type { TranslationsDto } from "../../../../src/shared/dto/translation.ts";
import { ContentPage } from "../../../../src/web/pages/content/content-page.tsx";
import { targetLanguageChoices } from "../../../../src/web/pages/content/translation-tab.tsx";
import { contentRoutes, revision } from "../../../fixtures/web/content-data.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

const EMPTY_CAPABILITY = { stream: "unknown", tools: "unknown", structuredOutput: "unknown", vision: "unknown", audioInput: "unknown", reasoning: "unknown" };
const PROVIDERS = {
  body: {
    items: [
      {
        id: "p1",
        name: "P",
        protocol: "openai_compatible",
        baseURL: "https://x",
        credentialStatus: "configured",
        hasCredential: true,
        models: [{ modelId: "m1", flags: { declared: EMPTY_CAPABILITY }, limits: { declared: {} }, effective: { flags: EMPTY_CAPABILITY, limits: {} } }],
        createdAt: 1,
      },
    ],
  },
};
const TRANSLATED = revision("t-en", { kind: "translated", language: "en", parentRevisionId: "r0", createdAt: new Date(2026, 9, 4, 12, 26).getTime() });

function translations(overrides: Partial<TranslationsDto> = {}): { body: TranslationsDto } {
  return {
    body: {
      translations: [{ artifactId: "ta1", targetLanguage: "en", current: TRANSLATED, revisions: [TRANSLATED], stale: true, staleReason: "transcript_changed" }],
      activeTasks: [],
      ...overrides,
    },
  };
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: BREAKPOINT_DRAWER_PX + 300 });
  localStorage.clear();
});

describe("targetLanguageChoices", () => {
  it("leaves out every tag of the source's language", () => {
    const choices = targetLanguageChoices("zh-CN");
    expect(choices).toContain("en");
    expect(choices.some((tag) => tag.startsWith("zh"))).toBe(false);
    expect(targetLanguageChoices(undefined)).toContain("zh-CN");
  });
});

describe("TranslationTab", () => {
  it("translates the chosen languages with the chosen model on the first click", async () => {
    const { calls } = mockApi({
      ...contentRoutes(),
      "GET /api/providers": PROVIDERS,
      "GET /api/contents/c1/translations": translations({ translations: [] }),
      "POST /api/contents/c1/translations": { status: 202, body: { taskId: "t9" } },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=translation", path: "/contents/:id" });
    await screen.findByTestId("translation-tab");
    expect(screen.queryByTestId("translation-language-zh-CN")).toBeNull();
    const start = await screen.findByTestId("translation-start");
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("translation-language-en"));
    fireEvent.change(screen.getByLabelText("其它语言", { exact: false }), { target: { value: "vi" } });
    fireEvent.click(screen.getByText("添加"));
    await waitFor(() => expect((screen.getByTestId("translation-language-vi") as HTMLInputElement).checked).toBe(true));
    fireEvent.click(start);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({ targetLanguages: ["en", "vi"], modelRef: { providerProfileId: "p1", modelId: "m1" } }),
    );
  });

  it("refuses an invalid or same-language custom tag", async () => {
    mockApi({ ...contentRoutes(), "GET /api/providers": PROVIDERS });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=translation", path: "/contents/:id" });
    const input = await screen.findByLabelText("其它语言", { exact: false });
    for (const value of ["not a tag", "zh-TW"]) {
      fireEvent.change(input, { target: { value } });
      expect((screen.getByText("添加").closest("button") as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("lists each language's current version, flags a stale one and opens it in the subtitles tab", async () => {
    mockApi({
      ...contentRoutes(),
      "GET /api/contents/c1/translations": translations(),
      "GET /api/contents/c1/transcript/revisions": { body: { primaryTranscriptRevisionId: "r1", revisions: [revision("r1"), TRANSLATED] } },
      "GET /api/transcript/revisions/t-en/segments": { body: { revision: TRANSLATED, items: [] } },
    });
    renderApp(<ContentPage />, { route: "/contents/c1?tab=translation", path: "/contents/:id" });
    const entry = await screen.findByTestId("translation-entry");
    expect(entry.getAttribute("data-language")).toBe("en");
    expect(within(entry).getByTestId("translation-stale").textContent).toBe("基于旧字幕版本");
    fireEvent.click(within(entry).getByTestId("translation-open"));
    const version = (await screen.findByTestId("subtitles-version")) as HTMLSelectElement;
    expect(version.value).toBe("t-en");
    expect(version.selectedOptions[0]?.textContent).toBe("翻译 · 英语 · 10-04 12:26");
  });
});
