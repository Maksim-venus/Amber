import type { ArtifactInputRef } from "./artifact.ts";

/** Why a derived artifact is stale, as artifact DTOs report it in `staleReason`. */
export type StaleReason = "transcript_changed" | "chapters_changed" | "member_changed" | "order_changed";

export type Freshness = { stale: false } | { stale: true; staleReason: StaleReason };

/** The current pointers an artifact's inputs are compared with. */
export interface CurrentPointers {
  primaryTranscriptRevisionId?: string;
  /** The Content's ChapterArtifact current revision. */
  chapterRevisionId?: string;
}

/**
 * Freshness is never stored as truth: it is derived by comparing the
 * revisions an artifact was built from with the pointers that are current now. A
 * transcript input that is no longer the primary makes it `transcript_changed`; a chapter
 * input that is no longer current, `chapters_changed`. Artifacts without such inputs —
 * platform chapters above all — are always fresh. Other input kinds are compared by the
 * artifacts that use them.
 */
export function deriveFreshness(inputs: readonly ArtifactInputRef[], current: CurrentPointers): Freshness {
  for (const input of inputs) {
    if (input.kind === "transcriptRevision" && input.id !== current.primaryTranscriptRevisionId) {
      return { stale: true, staleReason: "transcript_changed" };
    }
  }
  for (const input of inputs) {
    if (input.kind === "chapterRevision" && input.id !== current.chapterRevisionId) {
      return { stale: true, staleReason: "chapters_changed" };
    }
  }
  return { stale: false };
}

/** A collection member as a collection summary saw it, or as it is now. */
export interface CollectionMemberState {
  contentId: string;
  /** The member's `summary.core` current revision. */
  summaryRevisionId?: string;
  /** The member's primary transcript. */
  transcriptRevisionId?: string;
}

/**
 * Freshness of a collection summary: `inputItems` are compared
 * with the members as they are now, both in collection order. A different set of
 * members, or a member whose `summary.core` current or primary changed, is
 * `member_changed`; otherwise a different order is `order_changed`.
 */
export function deriveCollectionFreshness(snapshot: readonly CollectionMemberState[], current: readonly CollectionMemberState[]): Freshness {
  const now = new Map(current.map((member) => [member.contentId, member]));
  const sameMembers =
    snapshot.length === current.length &&
    snapshot.every((member) => {
      const present = now.get(member.contentId);
      return (
        present !== undefined &&
        present.summaryRevisionId === member.summaryRevisionId &&
        present.transcriptRevisionId === member.transcriptRevisionId
      );
    });
  if (!sameMembers) {
    return { stale: true, staleReason: "member_changed" };
  }
  if (snapshot.some((member, index) => current[index]?.contentId !== member.contentId)) {
    return { stale: true, staleReason: "order_changed" };
  }
  return { stale: false };
}
