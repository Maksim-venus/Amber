import type { NoteDto } from "../../../src/shared/dto/note.ts";

/** A note on the fixture Content `c1`, revision `r1`; values are synthetic. */
export function note(id: string, overrides: Partial<NoteDto> = {}): NoteDto {
  return {
    id,
    contentId: "c1",
    contentTitle: "第一讲",
    transcriptRevisionId: "r1",
    startSegmentId: "s1",
    startOffset: 0,
    endSegmentId: "s1",
    endOffset: 2,
    startMs: 0,
    quote: "今天",
    mark: "background",
    color: "yellow",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}
