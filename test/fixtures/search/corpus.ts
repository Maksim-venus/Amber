import { LOCAL, type Harness } from "../pipeline/harness.ts";

/**
 * A synthetic search corpus written through the same paths the product uses: a Content row
 * with its title projected as an import would, timed subtitles through `importSubtitle`
 * (an `imported` primary revision) and an optional reference text. The text is invented.
 */

export interface SeededContent {
  contentId: string;
  revisionId?: string;
  /** Segment ids of the primary revision, in order. */
  segmentIds: string[];
}

function srtTime(ms: number): string {
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

/** Five seconds per line. */
export function srtOf(lines: readonly string[]): string {
  return lines.map((line, index) => `${index + 1}\n${srtTime(index * 5000)} --> ${srtTime(index * 5000 + 5000)}\n${line}\n`).join("\n");
}

export function seedContent(
  h: Harness,
  input: { title?: string; lines?: readonly string[]; reference?: string; userId?: string },
): SeededContent {
  const userId = input.userId ?? LOCAL.userId;
  const principal = { ...LOCAL, userId };
  const contentId = h.newId();
  h.repository.withTransaction((scope) => {
    scope.contents.insert({
      id: contentId,
      userId,
      source: { kind: "local" },
      ...(input.title === undefined ? {} : { title: input.title }),
      processingStatus: "succeeded",
      createdAt: 1,
      updatedAt: 1,
    });
    scope.search.syncContent(userId, contentId);
  });
  let revisionId: string | undefined;
  if (input.lines !== undefined) {
    revisionId = h.contents.importSubtitle(principal, contentId, { text: srtOf(input.lines), format: "srt", language: "zh-CN" }).transcriptRevisionId;
  }
  if (input.reference !== undefined) {
    h.contents.importSubtitle(principal, contentId, { text: input.reference, format: "txt" });
  }
  const segmentIds =
    revisionId === undefined ? [] : h.repository.withTransaction((scope) => scope.transcripts.listSegments(userId, revisionId as string).map((segment) => segment.id));
  return { contentId, ...(revisionId === undefined ? {} : { revisionId }), segmentIds };
}

/** Every projection row, in a stable order, for comparing incremental updates with a rebuild. */
export function projectionSnapshot(h: Harness): unknown[] {
  return h.db
    .prepare(
      `SELECT text, kind, user_id, content_id, collection_id, revision_id, segment_id, start_ms FROM search_index
       ORDER BY user_id, kind, coalesce(content_id, ''), coalesce(collection_id, ''), coalesce(revision_id, ''), coalesce(segment_id, ''), text`,
    )
    .all();
}
