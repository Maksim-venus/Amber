import { afterEach, describe, expect, it } from "vitest";
import { coveredSentences, selectionBounds, textOffsetIn } from "../../../src/web/ui/dom-selection.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

function rangeOf(from: [Node, number], to: [Node, number]): Range {
  const range = document.createRange();
  range.setStart(from[0], from[1]);
  range.setEnd(to[0], to[1]);
  return range;
}

const $ = (selector: string): HTMLElement => document.querySelector(selector) as HTMLElement;

describe("textOffsetIn", () => {
  it("counts the text before a point across search marks and note runs", () => {
    document.body.innerHTML = `<span id="s">再看<mark>重排</mark><span data-note-ids="n1">序的</span>做法。</span>`;
    const sentence = $("#s");
    const tail = sentence.lastChild as Text;
    expect(textOffsetIn(sentence, tail, 1)).toBe(7);
    expect(textOffsetIn(sentence, $("mark").firstChild as Text, 1)).toBe(3);
  });

  it("counts the text of the children before an element boundary", () => {
    document.body.innerHTML = `<span id="s">再看<mark>重排</mark>序。</span>`;
    const sentence = $("#s");
    expect(textOffsetIn(sentence, sentence, 0)).toBe(0);
    expect(textOffsetIn(sentence, sentence, 2)).toBe(4);
    expect(textOffsetIn(sentence, sentence, 3)).toBe(6);
  });

  it("measures in UTF-16 units, so a character outside the BMP counts as two", () => {
    document.body.innerHTML = `<span id="s">😀重排</span>`;
    const sentence = $("#s");
    expect(textOffsetIn(sentence, sentence.firstChild as Text, 3)).toBe(3);
  });
});

const READING = `<div data-revision-id="r1" data-notes><p><button data-reading-time>0:40</button><span id="a" data-segment-id="s1">先看<mark>召回</mark>。</span>，<span id="b" data-segment-id="s2">再看重排序。</span><span id="c" data-segment-id="s3">最后生成。</span></p></div>`;

describe("selectionBounds", () => {
  it("gives sentence offsets inside one sentence split by a search mark", () => {
    document.body.innerHTML = READING;
    const range = rangeOf([$("#a").firstChild as Text, 1], [$("mark").firstChild as Text, 2]);
    expect(selectionBounds(range)).toEqual({ revisionId: "r1", start: { segmentId: "s1", offset: 1 }, end: { segmentId: "s1", offset: 4 } });
  });

  it("spans sentences, counting an end outside its sentence as the sentence edge", () => {
    document.body.innerHTML = READING;
    // From the paragraph time to the start of the third sentence: whole first and second sentences.
    const range = rangeOf([$("button").firstChild as Text, 0], [$("#c").firstChild as Text, 0]);
    expect(coveredSentences(range, $("[data-notes]")).map((node) => node.id)).toEqual(["a", "b"]);
    expect(selectionBounds(range)).toEqual({ revisionId: "r1", start: { segmentId: "s1", offset: 0 }, end: { segmentId: "s2", offset: 6 } });
    const across = rangeOf([$("#b").firstChild as Text, 2], [$("#c").firstChild as Text, 2]);
    expect(selectionBounds(across)).toEqual({ revisionId: "r1", start: { segmentId: "s2", offset: 2 }, end: { segmentId: "s3", offset: 2 } });
  });

  it("offers nothing outside a view that takes notes", () => {
    document.body.innerHTML = `<div data-revision-id="r1" data-explainable><span id="a" data-segment-id="s1">总结里的字。</span></div>`;
    expect(selectionBounds(rangeOf([$("#a").firstChild as Text, 0], [$("#a").firstChild as Text, 2]))).toBeUndefined();
  });

  it("offers nothing for a selection with no sentence text", () => {
    document.body.innerHTML = READING;
    const time = $("button").firstChild as Text;
    expect(selectionBounds(rangeOf([time, 0], [time, 2]))).toBeUndefined();
  });
});
