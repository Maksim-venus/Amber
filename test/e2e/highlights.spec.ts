import { expect, test } from "@playwright/test";
import { BILIBILI_CONTENT, installMockBackend } from "./mock-backend.ts";
import { HIGHLIGHT_SCORES } from "./mock-outputs.ts";

test("AI highlights: generated on the first click, the slider hides low scores, the player timeline shows the band", async ({ page }) => {
  const backend = await installMockBackend(page);
  await page.goto(`/contents/${BILIBILI_CONTENT}?tab=ai-highlights`);

  const tab = page.getByTestId("highlights-tab");
  await expect(tab).toContainText("还没有 AI 高光");
  expect(backend.mutations).toEqual([]);

  await page.getByTestId("highlights-generate").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The default threshold (80) lets the two strong highlights through.
  const items = page.getByTestId("highlight-item");
  await expect(items).toHaveCount(HIGHLIGHT_SCORES.filter((score) => score >= 80).length);
  await expect(items.first()).toContainText("第 1 句模拟字幕。");
  await expect(page.getByTestId("timeline-highlights").locator("[data-highlight]")).toHaveCount(2);
  expect(backend.mutations.map((mutation) => mutation.path)).toEqual([`/api/contents/${BILIBILI_CONTENT}/highlights/recompute`]);

  await page.getByTestId("highlights-threshold").fill("50");
  await expect(items).toHaveCount(3);
  await expect(page.getByTestId("timeline-highlights").locator("[data-highlight]")).toHaveCount(3);
  await page.getByTestId("highlights-threshold").fill("90");
  await expect(items).toHaveCount(1);
});
