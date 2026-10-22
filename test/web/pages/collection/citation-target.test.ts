import { describe, expect, it } from "vitest";
import type { SegmentId } from "../../../../src/shared/ids.ts";
import { citationHref } from "../../../../src/web/pages/collection/citation-target.ts";

const revision = {
  citations: [{ transcriptRevisionId: "r1", segmentId: "01SEGA" as SegmentId }],
  partials: [{ id: "p0", index: 0, body: "", createdAt: 0, citations: [{ transcriptRevisionId: "r2", segmentId: "01SEGB" as SegmentId }] }],
  inputItems: [
    { collectionItemId: "i1", contentId: "c1", transcriptRevisionId: "r1", position: 0 },
    { collectionItemId: "i2", contentId: "c2", transcriptRevisionId: "r2", position: 1 },
  ],
};

describe("citationHref", () => {
  it("opens the member content on the cited revision and sentence", () => {
    expect(citationHref("01SEGA", revision)).toBe("/contents/c1?tab=transcript&revision=r1&segment=01SEGA");
  });

  it("resolves citations that only appear in a partial", () => {
    expect(citationHref("01SEGB", revision)).toBe("/contents/c2?tab=transcript&revision=r2&segment=01SEGB");
  });

  it("returns undefined for unknown segments or transcripts outside the inputs", () => {
    expect(citationHref("01NONE", revision)).toBeUndefined();
    expect(citationHref("01SEGA", { ...revision, inputItems: [] })).toBeUndefined();
  });
});
