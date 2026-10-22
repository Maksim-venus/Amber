import { afterEach, describe, expect, it } from "vitest";
import { API_PAGE_SIZE_MAX } from "../../../../src/shared/defaults.ts";
import { noteDtoSchema, noteGroupsDtoSchema, noteListDtoSchema } from "../../../../src/shared/dto/note.ts";
import { lectureTranscripts } from "../../../fixtures/transcripts/lecture.ts";
import { BOB_TOKEN, createHarness, createLocalContent, LOCAL, LOCAL_TOKEN, type Harness } from "../../../fixtures/pipeline/harness.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

/** A Content with the lecture's ASR original and its proofread. */
async function setup() {
  const h = createHarness();
  open.push(h);
  const contentId = createLocalContent(h);
  const fixture = lectureTranscripts(contentId);
  h.repository.withTransaction((scope) => {
    for (const { revision, segments } of [fixture.asr, fixture.corrected]) {
      scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
    }
  });
  const { app } = await h.app();
  const first = fixture.corrected.segments[0]?.id as string;
  const payload = {
    transcriptRevisionId: fixture.corrected.revision.id, startSegmentId: first, startOffset: 0, endSegmentId: first, endOffset: 3, mark: "background", color: "yellow",
  };
  return { h, app, contentId, fixture, payload };
}

describe("POST /api/contents/:id/notes", () => {
  it("creates a note (201), replays an Idempotency-Key and refuses it with another body", async () => {
    const { app, contentId, payload } = await setup();
    const url = `/api/contents/${contentId}/notes`;
    const created = await app.inject({ method: "POST", url, headers: { ...auth, "idempotency-key": "note-1" }, payload });
    expect(created.statusCode).toBe(201);
    const note = noteDtoSchema.parse(created.json());
    expect(note.quote).toBe("大家好");
    const replay = await app.inject({ method: "POST", url, headers: { ...auth, "idempotency-key": "note-1" }, payload });
    expect([replay.statusCode, replay.json()]).toEqual([201, created.json()]);
    const conflict = await app.inject({ method: "POST", url, headers: { ...auth, "idempotency-key": "note-1" }, payload: { ...payload, color: "blue" } });
    expect([conflict.statusCode, conflict.json().error.class]).toEqual([409, "idempotency_conflict"]);
    const listed = noteListDtoSchema.parse((await app.inject({ method: "GET", url, headers: auth })).json());
    expect(listed.items.map((item) => item.id)).toEqual([note.id]);
  });

  it("validates the body and reports refined anchor errors", async () => {
    const { app, contentId, payload } = await setup();
    const url = `/api/contents/${contentId}/notes`;
    for (const bad of [{ ...payload, quote: "client text" }, { ...payload, mark: "strike" }, { ...payload, comment: "   " }, { ...payload, endOffset: 0 }]) {
      const response = await app.inject({ method: "POST", url, headers: auth, payload: bad });
      expect([response.statusCode, response.json().error.class]).toEqual([400, "invalid_request"]);
    }
    const anchor = await app.inject({ method: "POST", url, headers: auth, payload: { ...payload, startOffset: 3, endOffset: 2 } });
    expect([anchor.statusCode, anchor.json().error.code]).toEqual([400, "invalid_request.note_anchor"]);
    const malformedKey = await app.inject({ method: "POST", url, headers: { ...auth, "idempotency-key": "has space" }, payload });
    expect(malformedKey.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers: bob, payload })).statusCode).toBe(404);
  });
});

describe("GET /api/contents/:id/notes", () => {
  it("adds a view only when a revision is asked for, and refuses a revision of another Content", async () => {
    const { h, app, contentId, fixture, payload } = await setup();
    const url = `/api/contents/${contentId}/notes`;
    await app.inject({ method: "POST", url, headers: auth, payload });
    const plain = noteListDtoSchema.parse((await app.inject({ method: "GET", url, headers: auth })).json());
    expect("view" in (plain.items[0] ?? {})).toBe(false);
    const mapped = noteListDtoSchema.parse((await app.inject({ method: "GET", url: `${url}?revision=${fixture.asr.revision.id}`, headers: auth })).json());
    expect(mapped.items[0]?.view).toEqual({ segments: [{ segmentId: fixture.asr.segments[0]?.id, startOffset: 0, endOffset: 3 }], exact: true });
    const elsewhere = createLocalContent(h);
    const otherFixture = lectureTranscripts(elsewhere);
    h.repository.withTransaction((scope) => scope.transcripts.insertRevision(LOCAL.userId, otherFixture.asr.revision, otherFixture.asr.segments));
    expect((await app.inject({ method: "GET", url: `${url}?revision=${otherFixture.asr.revision.id}`, headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url, headers: bob })).statusCode).toBe(404);
  });
});

describe("PATCH and DELETE /api/notes/:id", () => {
  it("patches mark, colour and comment, deletes with 204 and then answers 404", async () => {
    const { app, contentId, payload } = await setup();
    const note = (await app.inject({ method: "POST", url: `/api/contents/${contentId}/notes`, headers: auth, payload: { ...payload, comment: "旧评论" } })).json() as { id: string };
    const url = `/api/notes/${note.id}`;
    const patched = await app.inject({ method: "PATCH", url, headers: auth, payload: { mark: "underline", comment: null } });
    expect(patched.statusCode).toBe(200);
    const dto = noteDtoSchema.parse(patched.json());
    expect([dto.mark, dto.comment]).toEqual(["underline", undefined]);
    expect((await app.inject({ method: "PATCH", url, headers: auth, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url, headers: auth, payload: { quote: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url, headers: bob, payload: { color: "green" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url, headers: bob })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url, headers: auth })).statusCode).toBe(404);
  });
});

describe("GET /api/notes/groups", () => {
  it("lists the caller's groups with a bounded limit", async () => {
    const { app, contentId, payload } = await setup();
    await app.inject({ method: "POST", url: `/api/contents/${contentId}/notes`, headers: auth, payload });
    const groups = noteGroupsDtoSchema.parse((await app.inject({ method: "GET", url: "/api/notes/groups", headers: auth })).json());
    expect(groups).toMatchObject({ items: [{ contentId, count: 1 }], total: 1 });
    expect(noteGroupsDtoSchema.parse((await app.inject({ method: "GET", url: "/api/notes/groups", headers: bob })).json())).toEqual({ items: [], total: 0 });
    expect((await app.inject({ method: "GET", url: `/api/notes/groups?limit=${API_PAGE_SIZE_MAX + 1}`, headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/notes/groups?cursor=bogus", headers: auth })).statusCode).toBe(400);
  });

  it("pages by number, never together with a cursor, and only with a safe integer from 1", async () => {
    const { h, app, contentId, payload } = await setup();
    await app.inject({ method: "POST", url: `/api/contents/${contentId}/notes`, headers: auth, payload });
    const later = createLocalContent(h);
    const fixture = lectureTranscripts(later);
    h.repository.withTransaction((scope) => scope.transcripts.insertRevision(LOCAL.userId, fixture.asr.revision, fixture.asr.segments));
    const first = fixture.asr.segments[0]?.id as string;
    await app.inject({
      method: "POST", url: `/api/contents/${later}/notes`, headers: auth,
      payload: { ...payload, transcriptRevisionId: fixture.asr.revision.id, startSegmentId: first, endSegmentId: first },
    });
    const everything = noteGroupsDtoSchema.parse((await app.inject({ method: "GET", url: "/api/notes/groups", headers: auth })).json()).items;
    expect(everything).toHaveLength(2);

    const second = await app.inject({ method: "GET", url: "/api/notes/groups?limit=1&page=2", headers: auth });
    expect(second.statusCode).toBe(200);
    expect(noteGroupsDtoSchema.parse(second.json())).toEqual({ items: [everything[1]], total: 2 });
    expect((await app.inject({ method: "GET", url: "/api/notes/groups?limit=1&page=3", headers: auth })).json()).toEqual({ items: [], total: 2 });

    const cursor = (await app.inject({ method: "GET", url: "/api/notes/groups?limit=1", headers: auth })).json().nextCursor as string;
    const both = await app.inject({ method: "GET", url: `/api/notes/groups?limit=1&page=1&cursor=${cursor}`, headers: auth });
    expect([both.statusCode, both.json().error.class, both.json().error.userMessage]).toEqual([400, "invalid_request", expect.stringMatching(/query\.page$/)]);
    for (const url of ["/api/notes/groups?page=0", "/api/notes/groups?page=1.5", "/api/notes/groups?page=9007199254740993", "/api/notes/groups?page=-1", "/api/notes/groups?page="]) {
      expect([url, (await app.inject({ method: "GET", url, headers: auth })).statusCode]).toEqual([url, 400]);
    }
  });
});
