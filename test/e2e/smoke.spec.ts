import { expect, test } from "@playwright/test";
import { CITED_INDEX, CITED_START_MS, installMockBackend, segmentId, YOUTUBE_CONTENT, YOUTUBE_URL } from "./mock-backend.ts";

const REVISION_PREFIX = "01J0000000000000000000REV1";
const OUTPUT_TABS = ["summary", "transcript", "subtitles", "translation", "ai-highlights"] as const;

test("end-to-end browser demo: new → live stage flow → summary → citation → omnibox → paste guard, tabs never call a model", async ({ page }) => {
  const backend = await installMockBackend(page);
  await page.goto("/new");

  await page.getByTestId("new-url-input").fill(YOUTUBE_URL);
  await page.getByTestId("new-submit").click();
  await expect(page).toHaveURL(new RegExp(`/contents/${YOUTUBE_CONTENT}`));

  // The empty state is the SSE-driven stage flow, replaced by the summary once it exists.
  await expect(page.getByTestId("task-flow")).toBeVisible();
  await expect(page.getByTestId("stage-source")).toHaveAttribute("data-status", "succeeded", { timeout: 15_000 });
  const summary = page.getByTestId("summary-body");
  await expect(summary).toBeVisible({ timeout: 30_000 });
  expect(backend.delivered()).toBeGreaterThan(6);

  // A citation seeks the player and selects the cited sentence in the transcript.
  const cited = segmentId(REVISION_PREFIX, CITED_INDEX);
  await summary.locator(`[data-citation="${cited}"]`).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __ytSeeks?: number[] }).__ytSeeks ?? [])).toContain(CITED_START_MS / 1000);
  await expect(page).toHaveURL(new RegExp(`segment=${cited}`));
  // …and the reading view opens on the cited sentence.
  await page.getByTestId("output-tab-transcript").click();
  await expect(page.locator(`[data-segment-id="${cited}"]`).first()).toHaveAttribute("aria-current", "true");

  // Switching every output tab only reads, never calls a model.
  const before = backend.mutations.length;
  for (const tab of OUTPUT_TABS) {
    await page.getByTestId(`output-tab-${tab}`).click();
    await expect(page.getByTestId(`output-tab-${tab}`)).toHaveAttribute("aria-selected", "true");
  }
  await page.getByTestId("output-tab-summary").click();
  expect(backend.mutations.slice(before)).toEqual([]);

  // Ctrl+K opens the Omnibox.
  await page.keyboard.press("Control+K");
  await expect(page.getByTestId("omnibox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("omnibox")).toBeHidden();

  // A pasted platform link outside any input jumps to /new with the link filled in.
  await page.goto("/library");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.evaluate((url) => {
    const data = new DataTransfer();
    data.setData("text/plain", url);
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  }, YOUTUBE_URL);
  await expect(page).toHaveURL(/\/new/);
  await expect(page.getByTestId("new-url-input")).toHaveValue(YOUTUBE_URL);

  // The only mutation of the whole run is the import itself.
  expect(backend.mutations.map((mutation) => `${mutation.method} ${mutation.path}`)).toEqual(["POST /api/contents/import"]);
});
