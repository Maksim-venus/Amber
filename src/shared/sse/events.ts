import { z } from "zod";
import { citationDtoSchema } from "../dto/citation.ts";
import { stageRunDtoSchema, taskDtoSchema, workUnitDtoSchema } from "../dto/task.ts";
import { CHAT_MESSAGE_STATUSES } from "../enums.ts";

/**
 * Wire frame: `event: <type>`, `data: <json>`, `id: <seq>`. Events are published only after
 * their state transaction commits and the sequence number is monotonic; replay is not
 * supported. Clients subscribe first, then read `GET /api/tasks/:id`, and apply only events
 * whose `id` exceeds the snapshot's `eventSeq`.
 */
export interface SseFrame<TType extends string, TData> {
  event: TType;
  data: TData;
  id: number;
}

export const TASK_EVENT_TYPES = ["task.updated", "stage.updated", "workunit.updated", "task.finished"] as const;
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

export const taskEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task.updated"), task: taskDtoSchema }),
  z.object({ type: z.literal("stage.updated"), stageRun: stageRunDtoSchema }),
  z.object({ type: z.literal("workunit.updated"), workUnit: workUnitDtoSchema }),
  z.object({ type: z.literal("task.finished"), task: taskDtoSchema }),
]);
export type TaskEvent = z.infer<typeof taskEventSchema>;

/** Events of a streamed chat answer; the model's control section never reaches the client. */
export const CHAT_EVENT_TYPES = ["answer.delta", "citation", "suggestions", "usage", "done"] as const;
export type ChatEventType = (typeof CHAT_EVENT_TYPES)[number];

export const chatEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("answer.delta"), delta: z.string() }),
  z.object({ type: z.literal("citation"), citation: citationDtoSchema }),
  z.object({ type: z.literal("suggestions"), suggestions: z.array(z.string()) }),
  z.object({
    type: z.literal("usage"),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("done"), messageId: z.string().min(1), status: z.enum(CHAT_MESSAGE_STATUSES) }),
]);
export type ChatEvent = z.infer<typeof chatEventSchema>;
