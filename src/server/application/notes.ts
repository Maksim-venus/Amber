import { monotonicFactory } from "ulid";
import { NOTE_SPAN_MAX_SEGMENTS, NOTES_PER_CONTENT_MAX } from "../../shared/defaults.ts";
import type { NoteCreateRequest, NoteDto, NoteGroupsDto, NoteListDto, NotePatchRequest } from "../../shared/dto/note.ts";
import { displayTitle, type Content } from "../domain/content.ts";
import { amberError } from "../domain/errors.ts";
import { mapNoteRange, RevisionSentences, type NoteView } from "../domain/note-map.ts";
import { noteAnchorProblem, noteQuote, type Note } from "../domain/note.ts";
import type { TranscriptRevision } from "../domain/transcript.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { NoteGroup, NoteGroupCursor, Repository, RepositoryScope, TimedNote } from "../ports/repository.ts";
import { jsonRequestDigest, runIdempotent, type IdempotentResult } from "./idempotency.ts";

export const NOTE_CREATE_ROUTE = "POST /api/contents/:id/notes";

export interface NoteServiceOptions {
  repository: Repository;
  now?: () => number;
  newId?: () => string;
}

function noteDto(note: TimedNote, content: Content, view?: NoteView | null): NoteDto {
  return {
    id: note.id,
    contentId: note.contentId,
    contentTitle: displayTitle(content) ?? "",
    transcriptRevisionId: note.transcriptRevisionId,
    startSegmentId: note.startSegmentId,
    startOffset: note.startOffset,
    endSegmentId: note.endSegmentId,
    endOffset: note.endOffset,
    startMs: note.startMs,
    quote: note.quote,
    mark: note.mark,
    color: note.color,
    ...(note.comment === undefined ? {} : { comment: note.comment }),
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    ...(view === undefined ? {} : { view }),
  };
}

function invalidAnchor(): never {
  throw amberError("invalid_request", "note anchor does not resolve in its revision", { code: "invalid_request.note_anchor" });
}

function encodeCursor(position: NoteGroupCursor): string {
  return Buffer.from(JSON.stringify([position.latestAt, position.contentId])).toString("base64url");
}

function decodeCursor(cursor: string): NoteGroupCursor {
  try {
    const [latestAt, contentId] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown[];
    if (typeof latestAt === "number" && Number.isInteger(latestAt) && typeof contentId === "string" && contentId.length > 0) {
      return { latestAt, contentId };
    }
  } catch {
    // Fall through to the uniform error below.
  }
  throw amberError("invalid_request", "malformed cursor", { params: { detail: "cursor" } });
}

/**
 * The user's notes on transcript text: created only by an
 * explicit action, never derived, never touching a model. The anchor is checked against
 * the stored revision and `quote` is cut from it here, never taken from the client. Every
 * read and write is scoped to the principal; another user's Content or note is `not_found`.
 */
export class NoteService {
  private readonly options: NoteServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: NoteServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
  }

  /**
   * The Content's notes in reading order. With `revisionId` each one also says where it
   * shows on that revision; sentence lookups are built once per revision for the request.
   */
  list(principal: RequestPrincipal, contentId: string, revisionId?: string): NoteListDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const content = ownedContent(scope, owner, contentId);
      let target: TranscriptRevision | undefined;
      if (revisionId !== undefined) {
        target = scope.transcripts.getRevision(owner, revisionId);
        if (target === undefined || target.contentId !== contentId) {
          throw amberError("not_found", "transcript revision not found");
        }
        if (target.kind === "translated") {
          throw amberError("invalid_request", "notes are not shown on a translation", { params: { detail: "revision" } });
        }
      }
      const notes = scope.notes.listByContent(owner, contentId);
      if (target === undefined) {
        return { items: notes.map((note) => noteDto(note, content)) };
      }
      const targetRevisionId = target.id;
      const revisions = new Map(scope.transcripts.listRevisions(owner, contentId).map((revision) => [revision.id, revision]));
      const loaded = new Map<string, RevisionSentences>();
      const sentencesOf = (id: string): RevisionSentences => {
        let sentences = loaded.get(id);
        if (sentences === undefined) {
          sentences = new RevisionSentences(scope.transcripts.listSegments(owner, id));
          loaded.set(id, sentences);
        }
        return sentences;
      };
      return {
        items: notes.map((note) => noteDto(note, content, mapNoteRange({ anchor: note, targetRevisionId, revisions, sentencesOf }))),
      };
    });
  }

  /**
   * `POST /api/contents/:id/notes`. Ownership of the Content is settled before anything
   * else, including an idempotent replay; the anchor, the span and the per-Content cap are
   * checked inside the same transaction that writes the note and its idempotency record.
   */
  create(principal: RequestPrincipal, contentId: string, body: NoteCreateRequest, idempotencyKey?: string): IdempotentResult<NoteDto> {
    const owner = principal.userId;
    const context = { userId: owner, route: NOTE_CREATE_ROUTE, key: idempotencyKey, requestDigest: jsonRequestDigest({ contentId, body }) };
    return this.options.repository.withTransaction((scope) => {
      const content = ownedContent(scope, owner, contentId);
      return runIdempotent(scope, context, this.now(), () => {
        const revision = scope.transcripts.getRevision(owner, body.transcriptRevisionId);
        if (revision === undefined || revision.contentId !== contentId) {
          throw amberError("not_found", "transcript revision not found");
        }
        const start = scope.transcripts.getSegment(owner, body.startSegmentId);
        const end = scope.transcripts.getSegment(owner, body.endSegmentId);
        const problem = noteAnchorProblem(body, revision, start, end);
        if (problem === "span") {
          throw amberError("invalid_request", "note spans too many sentences", {
            code: "invalid_request.note_span",
            params: { limit: String(NOTE_SPAN_MAX_SEGMENTS) },
            details: { limit: NOTE_SPAN_MAX_SEGMENTS },
          });
        }
        if (problem !== undefined || start === undefined || end === undefined) {
          invalidAnchor();
        }
        if (scope.notes.countByContent(owner, contentId) >= NOTES_PER_CONTENT_MAX) {
          throw amberError("invalid_request", "the Content holds the most notes allowed", {
            code: "invalid_request.note_limit",
            params: { limit: String(NOTES_PER_CONTENT_MAX) },
            details: { limit: NOTES_PER_CONTENT_MAX },
          });
        }
        const page = scope.transcripts.listSegments(owner, revision.id, { afterOrdinal: start.ordinal - 1, limit: end.ordinal - start.ordinal + 1 });
        const last = page.findIndex((segment) => segment.id === end.id);
        if (page[0]?.id !== start.id || last < 0) {
          invalidAnchor();
        }
        const now = this.now();
        const note: Note = {
          id: this.newId(),
          userId: owner,
          contentId,
          transcriptRevisionId: revision.id,
          startSegmentId: start.id,
          startOffset: body.startOffset,
          endSegmentId: end.id,
          endOffset: body.endOffset,
          quote: noteQuote(page.slice(0, last + 1), body.startOffset, body.endOffset),
          mark: body.mark,
          color: body.color,
          ...(body.comment === undefined ? {} : { comment: body.comment }),
          createdAt: now,
          updatedAt: now,
        };
        scope.notes.insert(note);
        return { status: 201, body: noteDto({ ...note, startMs: start.startMs }, content), resourceRefs: [note.id] };
      });
    });
  }

  /** Only the mark, the colour and the comment change; `comment: null` removes it. */
  patch(principal: RequestPrincipal, noteId: string, body: NotePatchRequest): NoteDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      visibleNote(scope, owner, noteId);
      const patch = {
        ...(body.mark === undefined ? {} : { mark: body.mark }),
        ...(body.color === undefined ? {} : { color: body.color }),
        ...(body.comment === undefined ? {} : { comment: body.comment ?? undefined }),
      };
      if (!scope.notes.update(owner, noteId, patch, this.now())) {
        throw amberError("not_found", "note not found");
      }
      return this.dtoOf(scope, owner, noteId);
    });
  }

  delete(principal: RequestPrincipal, noteId: string): void {
    const owner = principal.userId;
    this.options.repository.withTransaction((scope) => {
      visibleNote(scope, owner, noteId);
      if (!scope.notes.delete(owner, noteId)) {
        throw amberError("not_found", "note not found");
      }
    });
  }

  /**
   * One row per Content with notes, latest first; `total` counts Contents, not notes. Pages
   * either by `cursor` or by a 1-based `page` number, never both; a numbered
   * page carries no `nextCursor`, and one past the last page is empty.
   */
  groups(principal: RequestPrincipal, query: { limit: number; cursor?: string; page?: number }): NoteGroupsDto {
    const owner = principal.userId;
    if (query.cursor !== undefined && query.page !== undefined) {
      throw amberError("invalid_request", "cursor and page exclude each other", { params: { detail: "page" } });
    }
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    return this.options.repository.withTransaction((scope) => {
      const itemOf = (group: NoteGroup): NoteGroupsDto["items"][number] => ({
        contentId: group.contentId,
        title: displayTitle(ownedContent(scope, owner, group.contentId)) ?? "",
        count: group.count,
        latestAt: group.latestAt,
      });
      if (query.page !== undefined) {
        const total = scope.notes.countGroups(owner);
        // Compared as page indexes, so an absurdly large page number cannot overflow an offset.
        if (total === 0 || query.page - 1 > Math.floor((total - 1) / query.limit)) {
          return { items: [], total };
        }
        return { items: scope.notes.listGroups(owner, { limit: query.limit, offset: (query.page - 1) * query.limit }).map(itemOf), total };
      }
      const groups = scope.notes.listGroups(owner, { limit: query.limit + 1, ...(after === undefined ? {} : { after }) });
      const items = groups.slice(0, query.limit);
      const last = items.at(-1);
      return {
        items: items.map(itemOf),
        total: scope.notes.countGroups(owner),
        ...(groups.length > query.limit && last !== undefined ? { nextCursor: encodeCursor(last) } : {}),
      };
    });
  }

  private dtoOf(scope: RepositoryScope, owner: string, noteId: string): NoteDto {
    const note = scope.notes.get(owner, noteId);
    if (note === undefined) {
      throw amberError("not_found", "note not found");
    }
    return noteDto(note, ownedContent(scope, owner, note.contentId));
  }
}

/** A note of the owner on a Content outside the trash; a note of a trashed Content is as unknown as the Content. */
function visibleNote(scope: RepositoryScope, owner: string, noteId: string): TimedNote {
  const note = scope.notes.get(owner, noteId);
  if (note === undefined || scope.contents.get(owner, note.contentId) === undefined) {
    throw amberError("not_found", "note not found");
  }
  return note;
}

function ownedContent(scope: RepositoryScope, owner: string, contentId: string): Content {
  const content = scope.contents.get(owner, contentId);
  if (content === undefined) {
    throw amberError("not_found", "content not found");
  }
  return content;
}
