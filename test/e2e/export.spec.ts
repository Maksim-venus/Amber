import { expect, test, type Download } from "@playwright/test";
import { BILI_REVISION, BILIBILI_CONTENT, installMockBackend } from "./mock-backend.ts";
import { BILIBILI_TITLE } from "./mock-outputs.ts";

async function downloadedText(file: Download): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of await file.createReadStream()) {
    text += decoder.decode(chunk as Uint8Array, { stream: true });
  }
  return text + decoder.decode();
}

test("export: the summary tab's dialog downloads Markdown and the subtitles tab downloads an SRT, both under the lecture title", async ({ page }) => {
  const backend = await installMockBackend(page);
  await page.goto(`/contents/${BILIBILI_CONTENT}`);

  await page.getByTestId("summary-export").click();
  await expect(page.getByTestId("export-dialog")).toBeVisible();
  const markdown = page.waitForEvent("download");
  await page.getByTestId("export-markdown").click();
  const file = await markdown;
  expect(file.suggestedFilename()).toBe(`${BILIBILI_TITLE}.md`);
  expect((await downloadedText(file)).startsWith(`# ${BILIBILI_TITLE}`)).toBe(true);
  expect(backend.mutations.at(-1)?.body).toEqual({
    format: "markdown",
    sections: { summary: { templateId: "summary.core" }, transcript: { revisionId: BILI_REVISION } },
    backlinks: true,
  });
  await page.keyboard.press("Escape");

  await page.getByTestId("output-tab-subtitles").click();
  await page.getByTestId("subtitles-download").click();
  const srt = page.waitForEvent("download");
  await page.getByTestId("subtitles-download-srt").click();
  const subtitle = await srt;
  expect(subtitle.suggestedFilename()).toBe(`${BILIBILI_TITLE}.srt`);
  expect(backend.mutations.at(-1)?.body).toEqual({ format: "srt", revisionId: BILI_REVISION });
});
