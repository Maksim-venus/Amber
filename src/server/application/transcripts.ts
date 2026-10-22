import { monotonicFactory } from "ulid";
import type {
  DraftCommitRequest,
  SegmentMapDto,
  TranscriptDraftDto,
  TranscriptDraftRequest,
  TranscriptSegmentDto,
  TranscriptSegmentPageDto,
} from "../../shared/dto/transcript.ts";
import type { TranscriptRevisionDto } from "../../shared/dto/content.ts";
import type { SegmentId } from "../../shared/ids.ts";
import type { Content } from "../domain/content.ts";
import { amberError } from "../domain/errors.ts";
import { mapSegment } from "../domain/segment-map.ts";
import { inheritedParagraphStarts, timingFidelityFor, type TranscriptDraft, type TranscriptRevision, type TranscriptSegment } from "../domain/transcript.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import { transcriptRevisionDto } from "./contents.ts";

export interface TranscriptServiceOptions {
  repository: Repository;
  now?: () => number;
  newId?: () => string;
}

export function transcriptSegmentDto(segment: TranscriptSegment): TranscriptSegmentDto {
  return {
    id: segment.id,
    revisionId: segment.revisionId,
    ordinal: segment.ordinal,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
    ...(segment.words === undefined ? {} : { words: segment.words.map((word) => ({ ...word })) }),
    ...(segment.speakerId === undefined ? {} : { speakerId: segment.speakerId }),
    ...(segment.paragraphStart === undefined ? {} : { paragraphStart: segment.paragraphStart }),
    sourceSegmentIds: [...segment.sourceSegmentIds],
  };
}

function draftDto(draft: TranscriptDraft): TranscriptDraftDto {
  return {
    id: draft.id,
    contentId: draft.contentId,
    baseRevisionId: draft.baseRevisionId,
    segments: draft.segments.map((segment) => ({
      ...(segment.id === undefined ? {} : { id: segment.id }),
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      sourceSegmentIds: [...segment.sourceSegmentIds],
    })),
    updatedAt: draft.updatedAt,
  };
}

function encodeCursor(ordinal: number): string {
  return Buffer.from(JSON.stringify([ordinal])).toString("base64url");
}

function decodeCursor(cursor: string): number {
  try {
    const [ordinal] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown[];
    if (typeof ordinal === "number" && Number.isInteger(ordinal)) {
      return ordinal;
    }
  } catch {
    // Fall through to the uniform error below.
  }
  throw amberError("invalid_request", "malformed cursor", { params: { detail: "cursor" } });
}

function invalidDraft(detail: string, reason: string): never {
  throw amberError("invalid_request", `draft cannot be committed: ${reason}`, { params: { detail } });
}

/**
 * Reading transcript segments, the Draft → Commit cycle of manual revisions and the
 * "same sentence" mapping between revisions. Every read
 * and write is scoped to the principal; another user's ids are `not_found`.
 */
export class TranscriptService {
  private readonly options: TranscriptServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: TranscriptServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
  }

  /** One page of a revision's segments in `ordinal` order; the cursor is the last ordinal seen. */
  segments(principal: RequestPrincipal, revisionId: string, page: { limit: number; cursor?: string }): TranscriptSegmentPageDto {
    const owner = principal.userId;
    const afterOrdinal = page.cursor === undefined ? undefined : decodeCursor(page.cursor);
    return this.options.repository.withTransaction((scope) => {
      const revision = scope.transcripts.getRevision(owner, revisionId);
      if (revision === undefined || scope.contents.get(owner, revision.contentId) === undefined) {
        throw amberError("not_found", "transcript revision not found");
      }
      const segments = scope.transcripts.listSegments(owner, revisionId, {
        ...(afterOrdinal === undefined ? {} : { afterOrdinal }),
        limit: page.limit + 1,
      });
      const items = segments.slice(0, page.limit);
      const last = items.at(-1);
      return {
        revision: transcriptRevisionDto(revision),
        items: items.map(transcriptSegmentDto),
        ...(segments.length > page.limit && last !== undefined ? { nextCursor: encodeCursor(last.ordinal) } : {}),
      };
    });
  }

  getDraft(principal: RequestPrincipal, contentId: string): TranscriptDraftDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      ownedContent(scope, owner, contentId);
      const draft = scope.transcripts.getDraft(owner, contentId);
      if (draft === undefined) {
        throw amberError("not_found", "no draft for this content");
      }
      return draftDto(draft);
    });
  }

  /**
   * Autosave: replaces the Content's single draft. Only the shape and the base revision
   * are checked here; timing and sources are checked when the draft is committed, so a
   * draft may pass through intermediate states while it is being edited.
   */
  putDraft(principal: RequestPrincipal, contentId: string, body: TranscriptDraftRequest): TranscriptDraftDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      ownedContent(scope, owner, contentId);
      editableBase(scope, owner, contentId, body.baseRevisionId);
      const existing = scope.transcripts.getDraft(owner, contentId);
      const draft: TranscriptDraft = {
        id: existing?.id ?? this.newId(),
        contentId,
        baseRevisionId: body.baseRevisionId,
        segments: body.segments.map((segment) => ({
          ...(segment.id === undefined ? {} : { id: segment.id }),
          startMs: segment.startMs,
          endMs: segment.endMs,
          text: segment.text,
          sourceSegmentIds: segment.sourceSegmentIds as SegmentId[],
        })),
        updatedAt: this.now(),
      };
      scope.transcripts.putDraft(owner, draft);
      return draftDto(draft);
    });
  }

  /**
   * Commit: the draft becomes an immutable `manual` revision whose
   * parent is the draft's base, and the new primary — but only when the client saw the
   * primary that is current now. A different primary means someone switched it after the
   * editor was opened; that is a conflict for the user to resolve, never a silent
   * overwrite. Revision, primary pointer and draft removal commit together.
   */
  commitDraft(principal: RequestPrincipal, contentId: string, body: DraftCommitRequest): TranscriptRevisionDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const content = ownedContent(scope, owner, contentId);
      const draft = scope.transcripts.getDraft(owner, contentId);
      if (draft === undefined) {
        throw amberError("not_found", "no draft for this content");
      }
      const current = content.primaryTranscriptRevisionId;
      if (body.expectedPrimaryRevisionId !== current) {
        throw amberError("conflict", "the primary transcript changed since the draft was opened", {
          code: "conflict.primary_changed",
          ...(current === undefined ? {} : { details: { currentPrimaryRevisionId: current } }),
        });
      }
      const base = editableBase(scope, owner, contentId, draft.baseRevisionId);
      const baseSegments = new Map(scope.transcripts.listSegments(owner, base.id).map((segment) => [segment.id as string, segment]));
      if (draft.segments.length === 0) {
        invalidDraft("segments", "a revision needs at least one segment");
      }
      let previousStart = -Infinity;
      draft.segments.forEach((segment, index) => {
        const at = `segments.${index}`;
        if (!Number.isInteger(segment.startMs) || !Number.isInteger(segment.endMs) || segment.startMs < 0 || segment.startMs >= segment.endMs) {
          invalidDraft(at, "segment timing must satisfy 0 <= start < end");
        }
        if (segment.startMs < previousStart) {
          invalidDraft(at, "segment start times must not decrease");
        }
        previousStart = segment.startMs;
        if (segment.sourceSegmentIds.some((source) => !baseSegments.has(source))) {
          invalidDraft(`${at}.sourceSegmentIds`, "sources must be sentences of the base revision");
        }
      });

      const revisionId = this.newId();
      // The editor works sentence by sentence; paragraphing is carried over from the base.
      const paragraphStarts = inheritedParagraphStarts(baseSegments, draft.segments);
      const segments: TranscriptSegment[] = draft.segments.map((segment, ordinal) => {
        const first = segment.sourceSegmentIds[0];
        const speakerId = first === undefined ? undefined : baseSegments.get(first)?.speakerId;
        const paragraphStart = paragraphStarts[ordinal];
        return {
          id: this.newId() as SegmentId,
          revisionId,
          ordinal,
          startMs: segment.startMs,
          endMs: segment.endMs,
          text: segment.text,
          ...(speakerId === undefined ? {} : { speakerId }),
          ...(paragraphStart === undefined ? {} : { paragraphStart }),
          sourceSegmentIds: segment.sourceSegmentIds as SegmentId[],
        };
      });
      const now = this.now();
      const revision: TranscriptRevision = {
        id: revisionId,
        contentId,
        kind: "manual",
        parentRevisionId: base.id,
        language: base.language,
        timingFidelity: timingFidelityFor("manual"),
        generation: { kind: "manual" },
        segmentCount: segments.length,
        createdAt: now,
      };
      scope.transcripts.insertRevision(owner, revision, segments);
      scope.contents.setPrimaryTranscript(owner, contentId, revisionId, now);
      scope.search.syncContent(owner, contentId);
      scope.transcripts.deleteDraft(owner, contentId);
      return transcriptRevisionDto(revision);
    });
  }

  /** `GET /transcript/segments/:sid/map`: both ends must be the principal's and belong to one Content. */
  map(principal: RequestPrincipal, segmentId: string, targetRevisionId: string): SegmentMapDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const source = scope.transcripts.getSegment(owner, segmentId);
      const sourceRevision = source === undefined ? undefined : scope.transcripts.getRevision(owner, source.revisionId);
      if (source === undefined || sourceRevision === undefined || scope.contents.get(owner, sourceRevision.contentId) === undefined) {
        throw amberError("not_found", "segment not found");
      }
      const target = scope.transcripts.getRevision(owner, targetRevisionId);
      if (target === undefined || target.contentId !== sourceRevision.contentId) {
        throw amberError("not_found", "target revision not found");
      }
      const revisions = new Map(scope.transcripts.listRevisions(owner, target.contentId).map((revision) => [revision.id, revision]));
      const loaded = new Map<string, TranscriptSegment[]>();
      const segmentsOf = (revisionId: string): TranscriptSegment[] => {
        let segments = loaded.get(revisionId);
        if (segments === undefined) {
          segments = scope.transcripts.listSegments(owner, revisionId);
          loaded.set(revisionId, segments);
        }
        return segments;
      };
      return mapSegment({ source, targetRevisionId, revisions, segmentsOf });
    });
  }
}

function ownedContent(scope: RepositoryScope, owner: string, contentId: string): Content {
  const content = scope.contents.get(owner, contentId);
  if (content === undefined) {
    throw amberError("not_found", "content not found");
  }
  return content;
}

/** A manual revision is edited from one of the Content's own transcripts; a translation never serves as its base. */
function editableBase(scope: RepositoryScope, owner: string, contentId: string, revisionId: string): TranscriptRevision {
  const revision = scope.transcripts.getRevision(owner, revisionId);
  if (revision === undefined || revision.contentId !== contentId) {
    throw amberError("not_found", "transcript revision not found");
  }
  if (revision.kind === "translated") {
    throw amberError("invalid_request", "a translation cannot be the base of a manual revision", { params: { detail: "baseRevisionId" } });
  }
  return revision;
}
