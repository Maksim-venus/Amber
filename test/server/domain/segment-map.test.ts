import { describe, expect, it } from "vitest";
import { mapSegment, type SegmentMapInput } from "../../../src/server/domain/segment-map.ts";
import { SEEK_MATCH_TOLERANCE_MS } from "../../../src/shared/defaults.ts";

type Seg = { id: string; ordinal: number; startMs: number; endMs: number; sourceSegmentIds: string[] };

function world(revisions: Array<{ id: string; parentRevisionId?: string; segments: Array<[string, number, number, string[]?]> }>) {
  const segments = new Map<string, Seg[]>();
  for (const revision of revisions) {
    segments.set(
      revision.id,
      revision.segments.map(([id, startMs, endMs, sources], ordinal) => ({ id, ordinal, startMs, endMs, sourceSegmentIds: sources ?? [] })),
    );
  }
  const map = new Map(revisions.map(({ id, parentRevisionId }) => [id, parentRevisionId === undefined ? { id } : { id, parentRevisionId }]));
  return (sourceId: string, targetRevisionId: string) => {
    const owner = [...segments.entries()].find(([, list]) => list.some((segment) => segment.id === sourceId)) as [string, Seg[]];
    const source = { ...(owner[1].find((segment) => segment.id === sourceId) as Seg), revisionId: owner[0] };
    const input: SegmentMapInput = {
      source: source as unknown as SegmentMapInput["source"],
      targetRevisionId,
      revisions: map,
      segmentsOf: (revisionId) => (segments.get(revisionId) ?? []) as unknown as ReturnType<SegmentMapInput["segmentsOf"]>,
    };
    return mapSegment(input);
  };
}

describe("mapSegment", () => {
  const map = world([
    { id: "asr", segments: [["a0", 0, 1000], ["a1", 1000, 2000], ["a2", 2000, 3000]] },
    { id: "corrected", parentRevisionId: "asr", segments: [["c0", 0, 1000, ["a0"]], ["c1", 1000, 2000, ["a1"]], ["c2", 2000, 3000, ["a2"]]] },
    // A manual edit merged c1 and c2 and dropped nothing else.
    { id: "manual", parentRevisionId: "corrected", segments: [["m0", 0, 1000, ["c0"]], ["m1", 1000, 3000, ["c1", "c2"]]] },
    { id: "translated", parentRevisionId: "corrected", segments: [["t0", 0, 1000, ["c0"]], ["t1", 1000, 2000, ["c1"]], ["t2", 2000, 3000, ["c2"]]] },
    { id: "platform", segments: [["p0", 0, 1400], ["p1", 1400, 3000]] },
    { id: "sparse", segments: [["s0", 0, 500], ["s1", 9000, 9500]] },
  ]);

  it("follows lineage up, down and across siblings", () => {
    expect(map("c1", "asr")).toEqual({ segmentId: "a1", method: "lineage" });
    expect(map("a2", "manual")).toEqual({ segmentId: "m1", method: "lineage" });
    expect(map("m1", "asr")).toEqual({ segmentId: "a1", method: "lineage" });
    expect(map("t2", "manual")).toEqual({ segmentId: "m1", method: "lineage" });
    expect(map("a0", "asr")).toEqual({ segmentId: "a0", method: "lineage" });
  });

  it("falls back to time overlap across lineages, preferring the largest overlap", () => {
    expect(map("a1", "platform")).toEqual({ segmentId: "p1", method: "overlap" });
    expect(map("p1", "corrected")).toEqual({ segmentId: "c2", method: "overlap" });
  });

  it("takes the nearest start within the tolerance when nothing overlaps, and nothing beyond it", () => {
    expect(map("a1", "sparse")).toEqual({ segmentId: "s0", method: "nearest" });
    const far = world([
      { id: "x", segments: [["x0", 0, 100]] },
      { id: "y", segments: [["y0", SEEK_MATCH_TOLERANCE_MS + 1, SEEK_MATCH_TOLERANCE_MS + 2]] },
    ]);
    expect(far("x0", "y")).toEqual({ segmentId: null, method: "none" });
  });
});
