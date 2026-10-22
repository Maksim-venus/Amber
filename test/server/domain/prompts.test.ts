import { describe, expect, it } from "vitest";
import * as prompts from "../../../src/server/domain/prompts.ts";
import { CHAPTER_AI_PROMPT, chapterWindowNote, PROOFREAD_AUDIO_PROMPT, PROOFREAD_TEXT_PROMPT, renderPrompt, type BuiltinPrompt } from "../../../src/server/domain/prompts.ts";
import { EXPECTED_PROMPTS } from "../../fixtures/spec/prompts.ts";

const builtin = Object.values(prompts).filter(
  (value): value is BuiltinPrompt => typeof value === "object" && value !== null && "ref" in value && "text" in value,
);

describe("builtin prompts", () => {
  it("are exactly the expected prompts", () => {
    expect(EXPECTED_PROMPTS).toHaveLength(15);
    expect(builtin.map((prompt) => prompt.ref.id).sort()).toEqual(EXPECTED_PROMPTS.map((prompt) => prompt.id).sort());
  });

  it.each(EXPECTED_PROMPTS)("sends $id v$version verbatim", ({ id, version, text }) => {
    const prompt = builtin.find((candidate) => candidate.ref.id === id);
    expect(prompt?.ref).toEqual({ id, version });
    expect(prompt?.text).toBe(text);
  });

  it("prefixes the audio proofreading prompt to the whole text proofreading prompt", () => {
    expect(PROOFREAD_AUDIO_PROMPT.text.endsWith(`\n\n${PROOFREAD_TEXT_PROMPT.text}`)).toBe(true);
  });

  it("keeps the punctuation and paragraph rules of the proofreading prompt", () => {
    expect(PROOFREAD_TEXT_PROMPT.text).toContain("\n- 依据语义和上下文补全必要的标点（中文用全角标点，英文用半角标点）；补标点不算改写，但不得借此润色或改变表达\n");
    expect(PROOFREAD_TEXT_PROMPT.text).toContain("\n- 按内容划分自然段：");
    // v5: every sentence mark is a fixed time slice, fragments included, and the paragraph mark never goes inside a text.
    expect(PROOFREAD_TEXT_PROMPT.text).toContain("\n- 每个句标记 [s<n>] 对应字幕中一个固定的时间片：");
    expect(PROOFREAD_TEXT_PROMPT.text).toContain("\n- ¶ 只能紧跟句标记，表示这一整句是新段落的第一句；");
    expect(PROOFREAD_TEXT_PROMPT.text).toContain("不得因删除而省掉整行");
    expect(PROOFREAD_TEXT_PROMPT.text).not.toContain("填充词可酌情删除");
    // v4: the writing of numbers is kept as spoken; v3 told the model to turn every number into digits.
    expect(PROOFREAD_TEXT_PROMPT.text).toContain("\n- 保持原文的数字写法：");
    expect(PROOFREAD_TEXT_PROMPT.text).not.toContain("数字统一用阿拉伯数字");
  });

  it("fills known slots and leaves the others in place", () => {
    expect(renderPrompt("a {{x}} b {{y}}", { x: "1" })).toBe("a 1 b {{y}}");
    expect(renderPrompt(CHAPTER_AI_PROMPT.text, { output_language: "en" })).toContain("标题与概要使用 en");
  });

  it("notes the window only when the transcript is split", () => {
    expect(chapterWindowNote(1, 1)).toBe("");
    expect(chapterWindowNote(2, 3)).toBe("这是全文的第 2/3 段。");
  });
});
