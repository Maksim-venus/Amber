import { monotonicFactory } from "ulid";
import type { TranscriptRevision, TranscriptSegment } from "../../../src/server/domain/transcript.ts";
import type { SegmentId } from "../../../src/shared/ids.ts";

/**
 * Synthetic transcript of a short bilingual lecture, in three TranscriptKinds across two
 * generations: `platform` and `asr` are roots (generation 1); `corrected` is proofread from
 * `asr` sentence by sentence (generation 2). The text is invented; no real recording or
 * provider output is involved. Ids are fresh ULIDs on every call so several fixtures can
 * live in one database.
 */

interface Line {
  startMs: number;
  endMs: number;
  text: string;
}

/** Platform captions: sentence timing only, auto-generated wording. */
const PLATFORM_LINES: readonly Line[] = [
  { startMs: 0, endMs: 4200, text: "大家好，今天我们来讲检索增强生成" },
  { startMs: 4200, endMs: 9800, text: "也就是 rag，它把检索和生成结合起来" },
  { startMs: 9800, endMs: 15500, text: "首先看一下 embedding 模型是怎么工作的" },
  { startMs: 15500, endMs: 21000, text: "Then we compare it with plain prompting." },
];

/** ASR original: word timing, one misrecognition ("瑞格") for the proofread to fix. */
const ASR_LINES: ReadonlyArray<Line & { words: string[] }> = [
  { startMs: 120, endMs: 4100, text: "大家好，今天我们来讲检索增强生成。", words: ["大家好，", "今天", "我们", "来讲", "检索增强生成。"] },
  { startMs: 4300, endMs: 9700, text: "也就是瑞格，它把检索和生成结合起来。", words: ["也就是", "瑞格，", "它把", "检索和生成", "结合起来。"] },
  { startMs: 9900, endMs: 15400, text: "首先看一下 embedding 模型是怎么工作的。", words: ["首先", "看一下", "embedding", "模型", "是怎么工作的。"] },
  { startMs: 15600, endMs: 20900, text: "Then we compare it with plain prompting.", words: ["Then", "we", "compare", "it", "with", "plain", "prompting."] },
];

/** Proofread text; sentence timing is inherited from the ASR parent. */
const CORRECTED_TEXT: readonly string[] = [
  "大家好，今天我们来讲检索增强生成。",
  "也就是 RAG，它把检索和生成结合起来。",
  "首先看一下 Embedding 模型是怎么工作的。",
  "Then we compare it with plain prompting.",
];

export interface TranscriptFixture {
  platform: { revision: TranscriptRevision; segments: TranscriptSegment[] };
  asr: { revision: TranscriptRevision; segments: TranscriptSegment[] };
  corrected: { revision: TranscriptRevision; segments: TranscriptSegment[] };
}

/** Evenly spread word timing inside a segment; good enough for a synthetic fixture. */
function spreadWords(line: Line & { words: string[] }): Array<{ text: string; startMs: number; endMs: number }> {
  const step = Math.floor((line.endMs - line.startMs) / line.words.length);
  return line.words.map((text, index) => ({
    text,
    startMs: line.startMs + index * step,
    endMs: index === line.words.length - 1 ? line.endMs : line.startMs + (index + 1) * step,
  }));
}

export function lectureTranscripts(
  contentId: string,
  options: { createdAt?: number; asrProfileId?: string; modelProfileId?: string } = {},
): TranscriptFixture {
  const nextId = monotonicFactory();
  const createdAt = options.createdAt ?? 1_790_000_000_000;
  const segmentId = (): SegmentId => nextId() as SegmentId;

  const platformId = nextId();
  const platformSegments = PLATFORM_LINES.map((line, ordinal) => ({
    id: segmentId(),
    revisionId: platformId,
    ordinal,
    ...line,
    sourceSegmentIds: [],
  }));

  const asrId = nextId();
  const asrSegments = ASR_LINES.map((line, ordinal) => ({
    id: segmentId(),
    revisionId: asrId,
    ordinal,
    startMs: line.startMs,
    endMs: line.endMs,
    text: line.text,
    words: spreadWords(line),
    sourceSegmentIds: [],
  }));

  const correctedId = nextId();
  const correctedSegments = asrSegments.map((parent, ordinal) => ({
    id: segmentId(),
    revisionId: correctedId,
    ordinal,
    startMs: parent.startMs,
    endMs: parent.endMs,
    text: CORRECTED_TEXT[ordinal] ?? parent.text,
    sourceSegmentIds: [parent.id],
  }));

  return {
    platform: {
      revision: {
        id: platformId,
        contentId,
        kind: "platform",
        language: "zh-CN",
        timingFidelity: "segment_only",
        generation: { kind: "platform", acquisition: "guest" },
        segmentCount: platformSegments.length,
        createdAt,
      },
      segments: platformSegments,
    },
    asr: {
      revision: {
        id: asrId,
        contentId,
        kind: "asr",
        language: "zh-CN",
        timingFidelity: "exact_words",
        generation: { kind: "asr", asrProfileId: options.asrProfileId ?? "asr-profile-fixture", modelId: "scribe_v2" },
        segmentCount: asrSegments.length,
        createdAt: createdAt + 1,
      },
      segments: asrSegments,
    },
    corrected: {
      revision: {
        id: correctedId,
        contentId,
        kind: "corrected",
        parentRevisionId: asrId,
        language: "zh-CN",
        timingFidelity: "inherited_segment",
        generation: {
          kind: "llm",
          modelRef: {
            providerProfileId: options.modelProfileId ?? "llm-profile-fixture",
            modelId: "model-fixture",
            providerNameSnapshot: "relay-fixture",
            modelDisplaySnapshot: "model-fixture",
          },
          promptRef: { id: "proofread", version: 1 },
          promptSnapshot: "<proofread prompt snapshot>",
        },
        segmentCount: correctedSegments.length,
        createdAt: createdAt + 2,
      },
      segments: correctedSegments,
    },
  };
}
