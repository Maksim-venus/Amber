import { expect, test } from "@playwright/test";
import { CHAT_ANSWER_PREFIX, CHAT_METADATA_ANSWER, CHAT_SUGGESTIONS, setContextWindowUnknown, setNoTranscript } from "./mock-chat.ts";
import { BILI_REVISION, BILIBILI_CONTENT, CITED_INDEX, installMockBackend, PROFILE, segmentId } from "./mock-backend.ts";

const CITED = segmentId(BILI_REVISION, CITED_INDEX);

test("chat: a streamed answer renders with a clickable citation, suggestions only fill the input, explain only pre-fills", async ({ page }) => {
  const backend = await installMockBackend(page);
  await page.goto(`/contents/${BILIBILI_CONTENT}`);

  const panel = page.getByTestId("chat-panel");
  await expect(panel.getByTestId("chat-mode")).toHaveAttribute("data-mode", "full");
  const input = panel.getByTestId("chat-input");
  await input.fill("这一讲讲了什么？");
  await input.press("Enter");

  const answer = panel.locator('[data-testid="chat-message"][data-role="assistant"]');
  await expect(answer).toContainText(CHAT_ANSWER_PREFIX);
  await expect(answer).toHaveAttribute("data-status", "complete");
  const citation = answer.locator(`[data-citation="${CITED}"]`);
  await expect(citation).toHaveText("1:10");
  await expect(panel.getByTestId("chat-suggestion")).toHaveCount(CHAT_SUGGESTIONS.length);

  const posts = backend.mutations.filter((mutation) => mutation.path.endsWith("/chat/messages"));
  expect(posts).toHaveLength(1);
  expect(posts[0]?.body).toEqual({ text: "这一讲讲了什么？", modelRef: { providerProfileId: PROFILE, modelId: "mock-model" } });

  // The citation opens the reading view on the cited sentence.
  await citation.click();
  await expect(page).toHaveURL(new RegExp(`segment=${CITED}`));
  await expect(page.getByTestId("output-tab-transcript")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(`[data-segment-id="${CITED}"]`).first()).toHaveAttribute("aria-current", "true");

  // A suggestion fills the input and sends nothing.
  await panel.getByTestId("chat-suggestion").first().click();
  await expect(input).toHaveValue(CHAT_SUGGESTIONS[0] as string);

  // Selecting part of a sentence offers "explain": the question carries the selected text and the sentence is quoted.
  await input.fill("");
  const selected = await page.locator(`[data-segment-id="${CITED}"]`).first().evaluate((sentence) => {
    const text = sentence.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 1);
    range.setEnd(text, 4);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return range.toString().replace(/\s+/gu, " ").trim();
  });
  await page.getByTestId("selection-explain").click();
  await expect(input).toHaveValue(`解释一下「${selected}」`);
  await expect(panel.getByTestId("chat-quote")).toContainText(`第 ${CITED_INDEX + 1} 句模拟字幕。`);
  expect(backend.mutations.filter((mutation) => mutation.path.endsWith("/chat/messages"))).toHaveLength(1);
});

test("chat: an unknown context window greys the input out with a way to configure, until an override exists", async ({ page }) => {
  const backend = await installMockBackend(page);
  setContextWindowUnknown(page, BILIBILI_CONTENT);
  await page.goto(`/contents/${BILIBILI_CONTENT}`);

  const panel = page.getByTestId("chat-panel");
  await expect(panel.getByTestId("chat-unavailable")).toHaveAttribute("data-reason", "context_window_unknown");
  await expect(panel.getByTestId("chat-input")).toBeDisabled();
  await expect(panel.getByTestId("chat-send")).toBeDisabled();

  await panel.getByTestId("chat-configure").click();
  await expect(page).toHaveURL(/\/settings\/models/);
  // The model's context window is filled in through the Profile editor, which stores it as
  // the user override.
  const card = page.locator('[data-model="mock-model"]');
  await expect(card).toContainText("—");
  await page.getByRole("button", { name: "编辑" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("上下文窗口").fill("128000");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card).toContainText("128000");
  expect(backend.mutations.filter((mutation) => mutation.method === "PATCH" && mutation.path === `/api/providers/${PROFILE}`)).toHaveLength(1);
  await page.goBack();

  await expect(panel.getByTestId("chat-mode")).toHaveAttribute("data-mode", "full");
  await expect(panel.getByTestId("chat-unavailable")).toHaveCount(0);
  await expect(panel.getByTestId("chat-input")).toBeEnabled();
  expect(backend.mutations.filter((mutation) => mutation.path.endsWith("/chat/messages"))).toEqual([]);
});

test("chat without a transcript: the user can still ask, and the answer is labelled as not grounded in the video", async ({ page }) => {
  await installMockBackend(page);
  setNoTranscript(page, BILIBILI_CONTENT);
  await page.goto(`/contents/${BILIBILI_CONTENT}`);

  const panel = page.getByTestId("chat-panel");
  await expect(panel.getByTestId("chat-mode")).toHaveAttribute("data-mode", "metadata");
  await expect(panel.getByTestId("chat-metadata-hint")).toBeVisible();
  const input = panel.getByTestId("chat-input");
  await expect(input).toBeEnabled();
  await input.fill("这一讲大概讲什么？");
  await input.press("Enter");

  const answer = panel.locator('[data-testid="chat-message"][data-role="assistant"]');
  await expect(answer).toContainText(CHAT_METADATA_ANSWER);
  await expect(answer).toHaveAttribute("data-status", "complete");
  await expect(answer.getByTestId("chat-ungrounded")).toHaveText("未依据视频原文");
});
