import { describe, expect, it } from "vitest";
import { chatEventSchema, taskEventSchema } from "../../../src/shared/sse/events.ts";

const task = { id: "t1", kind: "process_content", statusProjection: "running", createdAt: 1 };

describe("SSE event DTOs", () => {
  it("parses task events", () => {
    expect(taskEventSchema.parse({ type: "task.updated", task })).toEqual({ type: "task.updated", task });
    const stageRun = {
      id: "s1",
      taskId: "t1",
      stage: "asr",
      attempt: 1,
      status: "waiting_configuration",
      progress: 0,
      dependencies: ["subtitle"],
      condition: "needs_asr",
    };
    expect(taskEventSchema.parse({ type: "stage.updated", stageRun }).type).toBe("stage.updated");
  });

  it("rejects unknown event types and out-of-range progress", () => {
    expect(taskEventSchema.safeParse({ type: "task.progress", task }).success).toBe(false);
    const stageRun = { id: "s1", taskId: "t1", stage: "asr", attempt: 1, status: "running", progress: 1.5, dependencies: [] };
    expect(taskEventSchema.safeParse({ type: "stage.updated", stageRun }).success).toBe(false);
  });

  it("carries canonical citations in chat events", () => {
    const citation = { transcriptRevisionId: "r1", segmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" };
    expect(chatEventSchema.parse({ type: "citation", citation })).toEqual({ type: "citation", citation });
    expect(chatEventSchema.safeParse({ type: "citation", citation: { ...citation, segmentId: "s17" } }).success).toBe(false);
  });
});
