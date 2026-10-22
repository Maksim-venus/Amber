import { expect, test } from "@playwright/test";
import { BILI_REVISION, BILIBILI_CONTENT, installMockBackend, segmentId, YOUTUBE_URL } from "./mock-backend.ts";

test("Omnibox search: a sentence hit opens the reading view on that sentence with the query", async ({ page }) => {
  const backend = await installMockBackend(page);
  await page.goto("/library");
  // The shortcut registry is live once the shell has rendered.
  await expect(page.getByTestId("library-row")).toHaveCount(1);
  await page.keyboard.press("Control+K");
  const omnibox = page.getByTestId("omnibox");
  await expect(omnibox).toBeVisible();
  await omnibox.locator("input").fill("第 8 句");

  const sentences = page.getByTestId("omnibox-group-segments");
  await expect(sentences).toBeVisible();
  await expect(sentences.getByRole("option")).toHaveCount(1);
  await sentences.getByRole("option").first().click();

  const target = segmentId(BILI_REVISION, 7);
  await expect(page).toHaveURL(new RegExp(`/contents/${BILIBILI_CONTENT}\\?.*segment=${target}`));
  const url = new URL(page.url());
  expect(url.searchParams.get("tab")).toBe("transcript");
  expect(url.searchParams.get("search")).toBe("第 8 句");
  await expect(page.getByTestId("output-tab-transcript")).toHaveAttribute("aria-selected", "true");
  const hit = page.getByTestId("transcript-reader").locator(`[data-segment-id="${target}"]`);
  await expect(hit).toHaveAttribute("aria-current", "true");
  await expect(hit.locator("mark").first()).toBeVisible();
  // Searching only reads.
  expect(backend.mutations).toEqual([]);
});

test("Library search: only hit Contents stay listed, each with an excerpt", async ({ page }) => {
  await installMockBackend(page);
  await page.goto("/new");
  await page.getByTestId("new-url-input").fill(YOUTUBE_URL);
  await page.getByTestId("new-submit").click();
  await page.goto("/library");
  await expect(page.getByTestId("library-row")).toHaveCount(2);

  await page.getByTestId("library-search").fill("B 站");
  await expect(page.getByTestId("library-row")).toHaveCount(1);
  const snippet = page.getByTestId("search-snippet");
  await expect(snippet).toHaveCount(1);
  await expect(snippet.locator("mark")).toHaveText(["B", "站"]);
  await expect(page.getByTestId("library-row").getByRole("link", { name: "第二讲：B 站模拟课程", exact: true })).toBeVisible();

  await page.getByTestId("library-search").fill("");
  await expect(page.getByTestId("library-row")).toHaveCount(2);
});
