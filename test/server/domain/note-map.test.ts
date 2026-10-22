import { describe, expect, it } from "vitest";
import { SEEK_MATCH_TOLERANCE_MS } from "../../../src/shared/defaults.ts";
import { mapNoteRange, RevisionSentences, type NoteView } from "../../../src/server/domain/note-map.ts";
import type { NoteAnchor } from "../../../src/server/domain/note.ts";

interface SentenceSpec {
  id: string;
  text: string;
  startMs?: number;
  endMs?: number;
  sources?: string[];
}
interface RevisionSpec {
  id: string;
  parent?: string;
  sentences: SentenceSpec[];
}

/** Revisions of one Content; a sentence without explicit timing occupies `[ordinal s, ordinal + 1 s)`. */
function world(specs: RevisionSpec[]) {
  const revisions = new Map(specs.map((spec) => [spec.id, { id: spec.id, ...(spec.parent === undefined ? {} : { parentRevisionId: spec.parent }) }]));
  const indexes = new Map(
    specs.map((spec) => [
      spec.id,
      new RevisionSentences(
        spec.sentences.map((sentence, ordinal) => ({
          id: sentence.id,
          ordinal,
          startMs: sentence.startMs ?? ordinal * 1000,
          endMs: sentence.endMs ?? ordinal * 1000 + 1000,
          text: sentence.text,
          sourceSegmentIds: sentence.sources ?? [],
        })),
      ),
    ]),
  );
  return {
    revisions,
    sentencesOf: (id: string): RevisionSentences => {
      const found = indexes.get(id);
      if (found === undefined) throw new Error(`no revision ${id}`);
      return found;
    },
  };
}

function map(w: ReturnType<typeof world>, anchor: NoteAnchor, targetRevisionId: string): NoteView | null {
  return mapNoteRange({ anchor, targetRevisionId, revisions: w.revisions, sentencesOf: w.sentencesOf });
}

const note = (revision: string, start: string, startOffset: number, end: string, endOffset: number): NoteAnchor => ({
  transcriptRevisionId: revision,
  startSegmentId: start,
  startOffset,
  endSegmentId: end,
  endOffset,
});
const whole = (...pairs: Array<[string, string]>): NoteView => ({
  segments: pairs.map(([segmentId, text]) => ({ segmentId, startOffset: 0, endOffset: text.length })),
  exact: false,
});

const ROOT: RevisionSpec = { id: "asr", sentences: [{ id: "a", text: "Alpha one." }, { id: "b", text: "Beta two." }, { id: "c", text: "Gamma three." }] };

describe("mapNoteRange on the anchor revision", () => {
  it("returns the anchor with its offsets, exact", () => {
    const w = world([ROOT]);
    expect(map(w, note("asr", "a", 2, "b", 4), "asr")).toEqual({
      segments: [
        { segmentId: "a", startOffset: 2, endOffset: 10 },
        { segmentId: "b", startOffset: 0, endOffset: 4 },
      ],
      exact: true,
    });
  });

  it("is null when the anchor no longer resolves", () => {
    const w = world([ROOT]);
    expect(map(w, note("asr", "missing", 0, "b", 1), "asr")).toBeNull();
    expect(map(w, note("asr", "c", 0, "a", 1), "asr")).toBeNull();
  });
});

describe("mapNoteRange within one lineage", () => {
  const corrected: RevisionSpec = {
    id: "corrected",
    parent: "asr",
    sentences: [
      { id: "a1", text: "Alpha one.", sources: ["a"] },
      { id: "b1", text: "Beta 2.", sources: ["b"] },
      { id: "c1", text: "Gamma three.", sources: ["c"] },
    ],
  };

  it("keeps character offsets across a 1:1 proofread whose text is unchanged, both directions", () => {
    const w = world([ROOT, corrected]);
    expect(map(w, note("corrected", "a1", 1, "a1", 5), "asr")).toEqual({ segments: [{ segmentId: "a", startOffset: 1, endOffset: 5 }], exact: true });
    expect(map(w, note("asr", "a", 1, "a", 5), "corrected")).toEqual({ segments: [{ segmentId: "a1", startOffset: 1, endOffset: 5 }], exact: true });
  });

  it("shows whole sentences once a mapped sentence's text changed", () => {
    const w = world([ROOT, corrected]);
    expect(map(w, note("corrected", "b1", 0, "b1", 4), "asr")).toEqual(whole(["b", "Beta two."]));
    expect(map(w, note("corrected", "a1", 3, "b1", 2), "asr")).toEqual(whole(["a", "Alpha one."], ["b", "Beta two."]));
  });

  it("follows a pure split: every piece of a sentence inside the note is wholly inside it", () => {
    const split: RevisionSpec = { id: "manual", parent: "asr", sentences: [{ id: "x1", text: "Alpha", sources: ["a"] }, { id: "x2", text: "one.", sources: ["a"] }] };
    const w = world([ROOT, split]);
    expect(map(w, note("asr", "a", 0, "a", 10), "manual")).toEqual(whole(["x1", "Alpha"], ["x2", "one."]));
    // One piece only: its parent also holds the other piece's text.
    expect(map(w, note("manual", "x1", 0, "x1", 5), "asr")).toEqual(whole(["a", "Alpha one."]));
    // Both pieces: the parent is wholly inside, but two sentences became one, so not exact.
    expect(map(w, note("manual", "x1", 0, "x2", 4), "asr")).toEqual(whole(["a", "Alpha one."]));
  });

  it("follows a pure merge: the merged sentence holds outside text unless all its sources are noted", () => {
    const merged: RevisionSpec = { id: "manual", parent: "asr", sentences: [{ id: "m", text: "Alpha one. Beta two.", sources: ["a", "b"] }, { id: "c2", text: "Gamma three.", sources: ["c"] }] };
    const w = world([ROOT, merged]);
    expect(map(w, note("asr", "a", 0, "a", 5), "manual")).toEqual(whole(["m", "Alpha one. Beta two."]));
    expect(map(w, note("asr", "a", 0, "b", 4), "manual")).toEqual(whole(["m", "Alpha one. Beta two."]));
    expect(map(w, note("manual", "m", 0, "m", 5), "asr")).toEqual(whole(["a", "Alpha one."], ["b", "Beta two."]));
  });

  it("drops a merged-then-split sentence instead of spreading the note onto both new pieces", () => {
    const merged: RevisionSpec = { id: "m1", parent: "asr", sentences: [{ id: "m", text: "Alpha one. Beta two.", sources: ["a", "b"] }, { id: "c2", text: "Gamma three.", sources: ["c"] }] };
    const resplit: RevisionSpec = {
      id: "m2",
      parent: "m1",
      sentences: [{ id: "a3", text: "Alpha one.", sources: ["m"] }, { id: "b3", text: "Beta two.", sources: ["m"] }, { id: "c3", text: "Gamma three.", sources: ["c2"] }],
    };
    const w = world([ROOT, merged, resplit]);
    expect(map(w, note("asr", "a", 0, "a", 5), "m2")).toBeNull();
    // Going up the same way: a piece of a resplit wider sentence, from several sources, is unknowable too.
    expect(map(w, note("m2", "a3", 0, "a3", 5), "asr")).toBeNull();
    // The untouched neighbour still maps sentence for sentence.
    expect(map(w, note("asr", "c", 0, "c", 5), "m2")).toEqual({ segments: [{ segmentId: "c3", startOffset: 0, endOffset: 5 }], exact: true });
    // Noted whole, the merged sentence lies wholly inside the note and so do its pieces.
    expect(map(w, note("asr", "a", 0, "b", 4), "m2")?.segments.map((segment) => segment.segmentId)).toEqual(["a3", "b3"]);
  });

  it("drops a note reaching a sibling branch through an ancestor split differently", () => {
    const parent: RevisionSpec = { id: "root", sentences: [{ id: "x", text: "One two three four." }] };
    const left: RevisionSpec = { id: "left", parent: "root", sentences: [{ id: "l1", text: "One two", sources: ["x"] }, { id: "l2", text: "three four.", sources: ["x"] }] };
    const right: RevisionSpec = { id: "right", parent: "root", sentences: [{ id: "r1", text: "One", sources: ["x"] }, { id: "r2", text: "two three four.", sources: ["x"] }] };
    const kept: RevisionSpec = { id: "kept", parent: "root", sentences: [{ id: "k1", text: "One two three four!", sources: ["x"] }] };
    const w = world([parent, left, right, kept]);
    expect(map(w, note("left", "l1", 0, "l1", 3), "right")).toBeNull();
    // A sibling that kept the sentence whole shows it whole.
    expect(map(w, note("left", "l1", 0, "l1", 3), "kept")).toEqual(whole(["k1", "One two three four!"]));
    // Both pieces noted: the ancestor sentence is wholly inside, so is every piece of the other split.
    expect(map(w, note("left", "l1", 0, "l2", 2), "right")).toEqual(whole(["r1", "One"], ["r2", "two three four."]));
  });

  it("drops a sentence whose chain breaks and never falls back to time, nor fills the gap", () => {
    const rewritten: RevisionSpec = {
      id: "manual",
      parent: "asr",
      sentences: [
        { id: "a2", text: "Alpha one.", sources: ["a"] },
        // Typed anew over the same time span as `b`: no link to it.
        { id: "n", text: "Something else.", startMs: 1000, endMs: 2000 },
        { id: "c2", text: "Gamma three.", sources: ["c"] },
      ],
    };
    const w = world([ROOT, rewritten]);
    expect(map(w, note("asr", "b", 0, "b", 4), "manual")).toBeNull();
    expect(map(w, note("manual", "n", 0, "n", 4), "asr")).toBeNull();
    expect(map(w, note("asr", "a", 0, "c", 5), "manual")).toEqual(whole(["a2", "Alpha one."], ["c2", "Gamma three."]));
  });

  it("walks several generations up to the common ancestor and down again", () => {
    const proofread: RevisionSpec = { id: "p", parent: "asr", sentences: ROOT.sentences.map((s) => ({ id: `p-${s.id}`, text: s.text, sources: [s.id] })) };
    const edited: RevisionSpec = { id: "e", parent: "p", sentences: ROOT.sentences.map((s) => ({ id: `e-${s.id}`, text: s.text, sources: [`p-${s.id}`] })) };
    const other: RevisionSpec = { id: "o", parent: "asr", sentences: ROOT.sentences.map((s) => ({ id: `o-${s.id}`, text: s.text, sources: [s.id] })) };
    const w = world([ROOT, proofread, edited, other]);
    expect(map(w, note("e", "e-a", 2, "e-b", 3), "o")).toEqual({
      segments: [
        { segmentId: "o-a", startOffset: 2, endOffset: 10 },
        { segmentId: "o-b", startOffset: 0, endOffset: 3 },
      ],
      exact: true,
    });
    expect(map(w, note("asr", "c", 0, "c", 5), "e")).toEqual({ segments: [{ segmentId: "e-c", startOffset: 0, endOffset: 5 }], exact: true });
  });
});

describe("mapNoteRange across lineages", () => {
  const platform: RevisionSpec = {
    id: "platform",
    sentences: [
      { id: "p1", text: "alpha one", startMs: 0, endMs: 900 },
      { id: "p2", text: "beta two", startMs: 900, endMs: 2100 },
      { id: "p3", text: "gamma three", startMs: 2100, endMs: 3000 },
    ],
  };

  it("takes the sentence overlapping each anchored one the most, as whole sentences", () => {
    const w = world([ROOT, platform]);
    // `b` is [1000, 2000): inside `p2`.
    expect(map(w, note("asr", "b", 0, "b", 4), "platform")).toEqual(whole(["p2", "beta two"]));
    // `p2` is [900, 2100): mostly `b`, so `b` alone, never the slivers of `a` and `c`.
    expect(map(w, note("platform", "p2", 0, "p2", 4), "asr")).toEqual(whole(["b", "Beta two."]));
    // Several anchored sentences landing on one target count once.
    expect(map(w, note("asr", "a", 0, "c", 3), "platform")).toEqual(whole(["p1", "alpha one"], ["p2", "beta two"], ["p3", "gamma three"]));
  });

  it("falls back to the nearest start within SEEK_MATCH_TOLERANCE_MS, and to nothing beyond it", () => {
    const later: RevisionSpec = { id: "later", sentences: [{ id: "l1", text: "late", startMs: 1000 + SEEK_MATCH_TOLERANCE_MS, endMs: 1000 + SEEK_MATCH_TOLERANCE_MS + 500 }] };
    const gap: RevisionSpec = { id: "gap", sentences: [{ id: "g1", text: "far", startMs: 2001 + SEEK_MATCH_TOLERANCE_MS, endMs: 3000 + SEEK_MATCH_TOLERANCE_MS }] };
    const w = world([{ id: "short", sentences: [{ id: "s", text: "short", startMs: 1000, endMs: 1001 }] }, later, gap]);
    expect(map(w, note("short", "s", 0, "s", 1), "later")).toEqual(whole(["l1", "late"]));
    expect(map(w, note("short", "s", 0, "s", 1), "gap")).toBeNull();
  });
});

/** `count` sentences of one second each starting at `offsetMs`, ids `<prefix><n>`. */
function sentences(prefix: string, count: number, offsetMs = 0, sources?: (n: number) => string[]): SentenceSpec[] {
  return Array.from({ length: count }, (_, n) => ({
    id: `${prefix}${n}`,
    text: `sentence ${n} of ${prefix}`,
    startMs: offsetMs + n * 1000,
    endMs: offsetMs + n * 1000 + 1000,
    ...(sources === undefined ? {} : { sources: sources(n) }),
  }));
}

function timed<T>(work: () => T): { result: T; ms: number } {
  const started = performance.now();
  const result = work();
  return { result, ms: performance.now() - started };
}

describe("mapNoteRange under load", () => {
  it("maps across a sentence merged from 50", () => {
    const w = world([
      { id: "root", sentences: sentences("s", 50) },
      { id: "merged", parent: "root", sentences: [{ id: "m", text: "everything", startMs: 0, endMs: 50_000, sources: Array.from({ length: 50 }, (_, n) => `s${n}`) }] },
    ]);
    const { result, ms } = timed(() => [map(w, note("root", "s3", 0, "s12", 2), "merged"), map(w, note("merged", "m", 0, "m", 4), "root")]);
    expect(result[0]).toEqual(whole(["m", "everything"]));
    expect(result[1]?.segments).toHaveLength(50);
    expect(result[1]?.exact).toBe(false);
    expect(ms).toBeLessThan(200);
  });

  it("maps across a sentence split into 50", () => {
    const w = world([
      { id: "root", sentences: [{ id: "x", text: "everything", startMs: 0, endMs: 50_000 }] },
      { id: "split", parent: "root", sentences: sentences("p", 50, 0, () => ["x"]) },
    ]);
    const { result, ms } = timed(() => [map(w, note("root", "x", 0, "x", 10), "split"), map(w, note("split", "p7", 0, "p9", 3), "root")]);
    expect(result[0]?.segments.map((segment) => segment.segmentId)).toEqual(Array.from({ length: 50 }, (_, n) => `p${n}`));
    expect(result[1]).toEqual(whole(["x", "everything"]));
    expect(ms).toBeLessThan(200);
  });

  it("maps 100 notes onto an unrelated 5000-sentence revision", () => {
    const w = world([
      { id: "platform", sentences: sentences("p", 5000) },
      { id: "asr", sentences: sentences("a", 5000, 400) },
    ]);
    const { result, ms } = timed(() => Array.from({ length: 100 }, (_, n) => map(w, note("asr", `a${n * 50}`, 0, `a${n * 50 + 19}`, 3), "platform")));
    expect(result.every((view) => view !== null && view.segments.length === 20 && !view.exact)).toBe(true);
    // `a50` is [50 400, 51 400): mostly `p50`.
    expect(result[1]?.segments[0]?.segmentId).toBe("p50");
    expect(ms).toBeLessThan(1000);
  });

  it("maps 100 notes along a three-generation chain of 5000 sentences", () => {
    const w = world([
      { id: "asr", sentences: sentences("a", 5000) },
      { id: "corrected", parent: "asr", sentences: sentences("c", 5000, 0, (n) => [`a${n}`]) },
      { id: "manual", parent: "corrected", sentences: sentences("m", 5000, 0, (n) => [`c${n}`]) },
    ]);
    const { result, ms } = timed(() =>
      Array.from({ length: 100 }, (_, n) => [map(w, note("manual", `m${n * 50}`, 1, `m${n * 50 + 19}`, 3), "asr"), map(w, note("asr", `a${n * 50}`, 1, `a${n * 50}`, 3), "manual")]),
    );
    // Texts differ by prefix, so the chain maps whole sentences one for one.
    expect(result.every(([up, down]) => up?.segments.length === 20 && down?.segments.length === 1)).toBe(true);
    expect(result[2]?.[1]?.segments[0]?.segmentId).toBe("m100");
    expect(ms).toBeLessThan(1000);
  });
});
