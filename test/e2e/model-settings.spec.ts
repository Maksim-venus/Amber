import { expect, test } from "@playwright/test";
import { installMockBackend } from "./mock-backend.ts";

test("model prices: set on an AI model and a transcription model, shown as one line marked as the user's own", async ({ page }) => {
  const backend = await installMockBackend(page);
  await page.goto("/settings/models");
  const llm = page.locator('[data-model="mock-model"]');
  await expect(llm.getByTestId("model-pricing-summary")).toHaveText("未设置价格");
  await llm.getByRole("button", { name: "价格 · mock-model" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("单价 1").fill("0.8");
  await dialog.getByRole("button", { name: "添加计费项" }).click();
  await dialog.getByLabel("单价 2").fill("2.7");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();
  await expect(llm.getByTestId("model-pricing-summary")).toHaveText("0.8 元 / 百万输入 tokens · 2.7 元 / 百万输出 tokens");

  await page.goto("/settings/transcription");
  const fun = page.locator('[data-testid="asr-profile-model"][data-model="fun-asr"]');
  await fun.getByRole("button", { name: "价格 · fun-asr" }).click();
  await dialog.getByLabel("计费单位 1").selectOption("audio_per_second");
  await dialog.getByLabel("单价 1").fill("0.00022");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(fun.getByTestId("model-pricing-summary")).toHaveText("0.00022 元 / 秒");
  // Reading the page again keeps the price.
  await page.reload();
  await expect(fun.getByTestId("model-pricing-summary")).toHaveText("0.00022 元 / 秒");
  expect(backend.mutations.map((mutation) => `${mutation.method} ${mutation.path}`)).toEqual([
    "PUT /api/providers/01J0000000000000000000PRF1/model-pricing",
    "PUT /api/asr-profiles/01J0000000000000000000ASR1/model-pricing",
  ]);
});

test("transcription models: a typed-in model is added with a family, then tested from its row", async ({ page }) => {
  const backend = await installMockBackend(page);
  await page.goto("/settings/transcription");
  await page.getByRole("button", { name: "编辑" }).click();
  const dialog = page.getByRole("dialog");
  const input = dialog.getByLabel("添加模型");
  await input.fill("fun-asr-2026");
  await input.press("Enter");
  const family = dialog.getByLabel("参数兼容 · fun-asr-2026");
  await expect(family).toHaveValue("fun_asr");
  await family.selectOption("qwen_audio");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();
  expect(backend.mutations.at(-1)?.body).toEqual({
    models: [{ modelId: "qwen-audio-3.1-asr-flash-filetrans" }, { modelId: "fun-asr" }, { modelId: "fun-asr-2026", family: "qwen_audio" }],
  });

  const added = page.locator('[data-testid="asr-profile-model"][data-model="fun-asr-2026"]');
  await expect(added.getByText("千问 ASR（发送热词）")).toBeVisible();
  await expect(added.getByTestId("asr-model-tested")).toHaveText("未测试");
  await expect(page.getByTestId("asr-test-hint")).toHaveText("测试连接会发送 2 秒测试音频，可能产生少量费用。");
  await added.getByRole("button", { name: "测试连接 · fun-asr-2026" }).click();
  await expect(added.getByTestId("asr-model-test-result")).toHaveText("可用 · 延迟 1234 ms");
  await expect(added.getByTestId("asr-model-tested")).toHaveText(/^实测于 /);
  // The new model can be picked as the default.
  await expect(page.getByLabel("默认转录模型").locator("option", { hasText: "fun-asr-2026" })).toHaveCount(1);
});

test("other models: profiles are added, reordered and folded, and nothing there can be tested", async ({ page }) => {
  await installMockBackend(page);
  await page.goto("/settings/other-models");
  await expect(page.getByTestId("other-models-intro")).toContainText("Amber 目前没有功能会调用这些模型");
  for (const [name, modelId, kind] of [
    ["Voices", "tts-1", "tts"],
    ["Video", "veo", "video_generation"],
  ] as const) {
    await page.getByRole("button", { name: "添加 Profile" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("名称").fill(name);
    await dialog.getByLabel("模型 ID").fill(modelId);
    await dialog.getByLabel("类型").selectOption(kind);
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog).toBeHidden();
  }
  const cards = page.getByTestId("other-model-profile-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(1).getByText("视频生成")).toBeVisible();
  await expect(page.getByRole("button", { name: /测试连接/ })).toHaveCount(0);

  await page.getByRole("button", { name: "拖动调整「Video」的顺序" }).focus();
  await page.keyboard.press("ArrowUp");
  await expect(cards.first()).toHaveAttribute("data-profile", "Video");
  await page.reload();
  await expect(cards.first()).toHaveAttribute("data-profile", "Video");

  await cards.nth(1).getByRole("button", { name: "收起「Voices」" }).click();
  await expect(cards.nth(1).getByText("1 个模型")).toBeVisible();
  await page.reload();
  await expect(cards.nth(1).getByText("1 个模型")).toBeVisible();
  await expect(cards.nth(1).getByTestId("other-model")).toHaveCount(0);
});
