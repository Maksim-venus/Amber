import { expect, test } from "@playwright/test";
import { BILIBILI_CONTENT, installMockBackend, PROFILE } from "./mock-backend.ts";

test("translation: chosen languages are translated on the first click and open in the subtitles version switch", async ({ page }) => {
  const backend = await installMockBackend(page);
  await page.goto(`/contents/${BILIBILI_CONTENT}?tab=translation`);

  const tab = page.getByTestId("translation-tab");
  await expect(tab).toContainText("还没有译文");
  // The source is Chinese, so Chinese is not offered as a target.
  await expect(page.getByTestId("translation-language-zh-CN")).toHaveCount(0);
  await tab.getByText("英语", { exact: true }).click();
  await page.getByTestId("translation-start").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const entry = page.getByTestId("translation-entry");
  await expect(entry).toHaveAttribute("data-language", "en");
  expect(backend.mutations).toEqual([
    { method: "POST", path: `/api/contents/${BILIBILI_CONTENT}/translations`, body: { targetLanguages: ["en"], modelRef: { providerProfileId: PROFILE, modelId: "mock-model" } } },
  ]);

  await entry.getByTestId("translation-open").click();
  await expect(page.getByTestId("output-tab-subtitles")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("subtitles-version").locator("option:checked")).toHaveText(/^翻译 · 英语 · /);
  await expect(page.getByTestId("subtitle-rows")).toContainText("[en] 第 1 句模拟字幕。");
});
