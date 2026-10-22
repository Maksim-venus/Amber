import { describe, expect, it } from "vitest";
import { retryStageRequestSchema, stageRunDtoSchema, taskDetailDtoSchema, taskDtoSchema, taskListDtoSchema } from "../../../src/shared/dto/task.ts";

describe("task DTOs", () => {
  it("carry eventSeq on both snapshots", () => {
    expect(taskListDtoSchema.safeParse({ items: [] }).success).toBe(false);
    expect(taskListDtoSchema.parse({ items: [], eventSeq: 0 })).toEqual({ items: [], eventSeq: 0 });
    expect(taskDetailDtoSchema.shape.eventSeq).toBeDefined();
  });

  it("accept retry-stage with an optional modelRef only", () => {
    expect(retryStageRequestSchema.safeParse({ stage: "proofread" }).success).toBe(true);
    expect(retryStageRequestSchema.safeParse({ stage: "proofread", modelRef: { providerProfileId: "p", modelId: "m" } }).success).toBe(true);
    expect(retryStageRequestSchema.safeParse({ stage: "proofread", attempt: 2 }).success).toBe(false);
    expect(retryStageRequestSchema.safeParse({ stage: "download" }).success).toBe(false);
  });

  it("name the target and the engine of a stage, either a model or an ASR provider", () => {
    const task = { id: "t", contentId: "c", kind: "process_content", statusProjection: "running", targetTitle: "Lecture", createdAt: 1 };
    expect(taskDtoSchema.parse(task)).toEqual(task);
    const run = { id: "s", taskId: "t", stage: "summary", attempt: 1, status: "running", progress: 0, dependencies: [] };
    const llm = { kind: "llm", modelRef: { providerProfileId: "p", modelId: "m" } };
    expect(stageRunDtoSchema.parse({ ...run, engine: llm }).engine).toEqual(llm);
    const asr = { kind: "asr", asrModelRef: { asrProfileId: "a", modelId: "fun-asr" }, provider: "dashscope" };
    expect(stageRunDtoSchema.parse({ ...run, engine: asr }).engine).toEqual(asr);
    // A deleted profile without usage still names its binding.
    const bare = { kind: "asr", asrModelRef: { asrProfileId: "a", modelId: "fun-asr" } };
    expect(stageRunDtoSchema.parse({ ...run, engine: bare }).engine).toEqual(bare);
    expect(stageRunDtoSchema.safeParse({ ...run, engine: { kind: "asr", asrProfileId: "a" } }).success).toBe(false);
    expect(stageRunDtoSchema.safeParse({ ...run, engine: { kind: "asr", provider: "elevenlabs" } }).success).toBe(false);
    expect(stageRunDtoSchema.safeParse({ ...run, engine: { kind: "ocr", provider: "x" } }).success).toBe(false);
  });
});
