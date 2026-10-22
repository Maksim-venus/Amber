import { monotonicFactory } from "ulid";
import type { ModelRef } from "../../../src/server/domain/model-ref.ts";
import type { TranscriptSegment } from "../../../src/server/domain/transcript.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";
import { configureLlm, createLocalContent, LOCAL, type Harness } from "./harness.ts";

/** Synthetic lecture sentences: topic words repeat every eight sentences, so retrieval has something to find. */
const TOPICS = ["梯度下降", "学习率", "损失函数", "过拟合", "正则化", "反向传播", "批量归一化", "注意力机制"];
export const lectureLine = (index: number): string => `第 ${index + 1} 句：这里讲解${TOPICS[index % TOPICS.length]}的要点与例子。`;

export interface ChatContent {
  contentId: string;
  revisionId: string;
  segments: TranscriptSegment[];
}

/**
 * A local Content whose primary revision has `count` ten-second sentences, projected into
 * the search index the way a published revision would be.
 */
export function seedChatContent(h: Harness, count: number, options: { userId?: string; line?: (index: number) => string } = {}): ChatContent {
  const userId = options.userId ?? LOCAL.userId;
  const line = options.line ?? lectureLine;
  const contentId = createLocalContent(h, userId);
  const nextId = monotonicFactory();
  const revisionId = nextId();
  const segments: TranscriptSegment[] = Array.from({ length: count }, (_, ordinal) => ({
    id: nextId() as SegmentId,
    revisionId,
    ordinal,
    startMs: ordinal * 10_000,
    endMs: ordinal * 10_000 + 9_000,
    text: line(ordinal),
    sourceSegmentIds: [],
  }));
  h.repository.withTransaction((scope) => {
    scope.transcripts.insertRevision(
      userId,
      {
        id: revisionId,
        contentId,
        kind: "imported",
        language: "zh-CN",
        timingFidelity: "segment_only",
        generation: { kind: "imported", format: "srt" },
        segmentCount: count,
        createdAt: 1,
      },
      segments,
    );
    scope.contents.setPrimaryTranscript(userId, contentId, revisionId, 2);
    scope.search.syncContent(userId, contentId);
  });
  return { contentId, revisionId, segments };
}

/** A configured model whose user-stated context window is `contextWindowTokens`. */
export function configureChatModel(h: Harness, contextWindowTokens: number, userId = LOCAL.userId): ModelRef {
  const modelRef = configureLlm(h, userId);
  setContextWindow(h, modelRef, contextWindowTokens);
  return modelRef;
}

/** Rewrites (or with `undefined`, clears) the model's user-stated limits. */
export function setContextWindow(h: Harness, modelRef: ModelRef, contextWindowTokens: number | undefined): void {
  h.db
    .prepare("UPDATE model_capability SET limits_user_override_json = ? WHERE profile_id = ? AND model_id = ?")
    .run(contextWindowTokens === undefined ? null : JSON.stringify({ contextWindowTokens }), modelRef.providerProfileId, modelRef.modelId);
}
