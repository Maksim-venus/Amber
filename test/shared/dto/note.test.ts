import { describe, expect, it } from "vitest";
import { NOTE_COMMENT_MAX_CHARS } from "../../../src/shared/defaults.ts";
import { noteCreateRequestSchema, notePatchRequestSchema } from "../../../src/shared/dto/note.ts";

const CREATE = {
  transcriptRevisionId: "r1",
  startSegmentId: "s1",
  startOffset: 0,
  endSegmentId: "s2",
  endOffset: 3,
  mark: "background",
  color: "yellow",
} as const;

describe("note DTOs", () => {
  it("accepts an anchor with a mark, colour and optional comment, and nothing else", () => {
    expect(noteCreateRequestSchema.parse(CREATE)).toEqual(CREATE);
    expect(noteCreateRequestSchema.parse({ ...CREATE, comment: "  好句  " }).comment).toBe("好句");
    expect(noteCreateRequestSchema.safeParse({ ...CREATE, quote: "client text" }).success).toBe(false);
    expect(noteCreateRequestSchema.safeParse({ ...CREATE, color: "red" }).success).toBe(false);
    expect(noteCreateRequestSchema.safeParse({ ...CREATE, mark: "highlight" }).success).toBe(false);
    expect(noteCreateRequestSchema.safeParse({ ...CREATE, endOffset: 0 }).success).toBe(false);
    expect(noteCreateRequestSchema.safeParse({ ...CREATE, startOffset: -1 }).success).toBe(false);
    expect(noteCreateRequestSchema.safeParse({ ...CREATE, startOffset: 1.5 }).success).toBe(false);
    expect(noteCreateRequestSchema.safeParse({ ...CREATE, comment: "   " }).success).toBe(false);
    expect(noteCreateRequestSchema.safeParse({ ...CREATE, comment: "x".repeat(NOTE_COMMENT_MAX_CHARS + 1) }).success).toBe(false);
  });

  it("patches mark, colour or comment, with null clearing the comment", () => {
    expect(notePatchRequestSchema.parse({ comment: null })).toEqual({ comment: null });
    expect(notePatchRequestSchema.parse({ mark: "underline", color: "blue" })).toEqual({ mark: "underline", color: "blue" });
    expect(notePatchRequestSchema.safeParse({}).success).toBe(false);
    expect(notePatchRequestSchema.safeParse({ startOffset: 2 }).success).toBe(false);
  });
});
