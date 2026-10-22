import { expect, test } from "@playwright/test";
import { BILIBILI_BVID, BILIBILI_CONTENT, CITED_INDEX, CITED_START_MS, installMockBackend, segmentId } from "./mock-backend.ts";

const REVISION_PREFIX = "01J0000000000000000000REV2";

test("bilibili iframe: no time tracking, so cursor / following / current sentence are hidden; seeking reloads with t=", async ({ page }) => {
  await installMockBackend(page);
  await page.goto(`/contents/${BILIBILI_CONTENT}`);

  const frame = page.getByTestId("player-bilibili");
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute("src", new RegExp(`bvid=${BILIBILI_BVID}`));
  await expect(page.getByTestId("bili-hint")).toBeVisible();
  await expect(page.getByTestId("timeline-cursor")).toHaveCount(0);

  await page.getByTestId("output-tab-subtitles").click();
  await expect(page.getByTestId("output-tab-subtitles")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-segment-id]").first()).toBeVisible();
  await expect(page.getByTestId("follow-toggle")).toHaveCount(0);
  await expect(page.getByTestId("current-sentence")).toHaveCount(0);

  await page.getByTestId("output-tab-summary").click();
  const cited = segmentId(REVISION_PREFIX, CITED_INDEX);
  await page.getByTestId("summary-body").locator(`[data-citation="${cited}"]`).click();
  await expect(frame).toHaveAttribute("src", new RegExp(`[?&]t=${CITED_START_MS / 1000}(&|$)`));
});
