import { describe, expect, it } from "vitest";
import { deriveCollectionFreshness, deriveFreshness } from "../../../src/server/domain/freshness.ts";

describe("deriveFreshness", () => {
  it("is fresh while every compared input is current", () => {
    expect(deriveFreshness([{ kind: "transcriptRevision", id: "t1" }, { kind: "chapterRevision", id: "c1" }], { primaryTranscriptRevisionId: "t1", chapterRevisionId: "c1" })).toEqual({
      stale: false,
    });
  });

  it("reports transcript_changed before chapters_changed", () => {
    const inputs = [{ kind: "chapterRevision", id: "c1" }, { kind: "transcriptRevision", id: "t1" }] as const;
    expect(deriveFreshness(inputs, { primaryTranscriptRevisionId: "t2", chapterRevisionId: "c2" })).toEqual({ stale: true, staleReason: "transcript_changed" });
    expect(deriveFreshness(inputs, { primaryTranscriptRevisionId: "t1", chapterRevisionId: "c2" })).toEqual({ stale: true, staleReason: "chapters_changed" });
    expect(deriveFreshness([{ kind: "transcriptRevision", id: "t1" }], {})).toEqual({ stale: true, staleReason: "transcript_changed" });
  });

  it("keeps an artifact without transcript or chapter inputs fresh, as platform chapters are", () => {
    expect(deriveFreshness([], { primaryTranscriptRevisionId: "t9" })).toEqual({ stale: false });
    expect(deriveFreshness([{ kind: "referenceText", id: "r1" }], {})).toEqual({ stale: false });
  });
});

describe("collection summary freshness", () => {
  const a = { contentId: "a", summaryRevisionId: "sa", transcriptRevisionId: "ta" };
  const b = { contentId: "b", summaryRevisionId: "sb", transcriptRevisionId: "tb" };

  it("is fresh while members, their currents and order are unchanged", () => {
    expect(deriveCollectionFreshness([a, b], [a, b])).toEqual({ stale: false });
  });

  it("is order_changed when only the order differs", () => {
    expect(deriveCollectionFreshness([a, b], [b, a])).toEqual({ stale: true, staleReason: "order_changed" });
  });

  it("is member_changed when a member is added or removed, or its core summary or primary changed", () => {
    const c = { contentId: "c", summaryRevisionId: "sc", transcriptRevisionId: "tc" };
    expect(deriveCollectionFreshness([a, b], [a, b, c])).toEqual({ stale: true, staleReason: "member_changed" });
    expect(deriveCollectionFreshness([a, b], [a])).toEqual({ stale: true, staleReason: "member_changed" });
    expect(deriveCollectionFreshness([a, b], [a, { ...b, summaryRevisionId: "sb2" }])).toEqual({ stale: true, staleReason: "member_changed" });
    expect(deriveCollectionFreshness([a, b], [{ ...a, transcriptRevisionId: "ta2" }, b])).toEqual({ stale: true, staleReason: "member_changed" });
    // Membership wins over order.
    expect(deriveCollectionFreshness([a, b], [{ contentId: "b", transcriptRevisionId: "tb" }, a])).toEqual({ stale: true, staleReason: "member_changed" });
  });
});
