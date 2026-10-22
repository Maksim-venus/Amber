import { describe, expect, it } from "vitest";
import { monotonicFactory } from "ulid";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { canonicalLanguageTag, decodeSubtitleText, importedTranscript, parseTimedSubtitle } from "../../../src/server/domain/subtitle-file.ts";
import { checkTranscriptInvariants } from "../../../src/server/domain/transcript.ts";

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (isAmberError(error)) {
      return error.appError.code;
    }
    throw error;
  }
  throw new Error("expected a failure");
}

const SRT = `1
00:00:01,000 --> 00:00:02,500
Hello
world

2
00:00:03,000 --> 00:00:04,000
<i>第二句</i>

3
00:00:05,000 --> 00:00:05,000
zero length

4
00:00:06,000 --> 00:00:07,000
`;

const VTT = `WEBVTT - lecture

NOTE this is a comment
00:00:00.000 --> 00:00:01.000

intro
00:01.000 --> 00:02.000 align:start
Tom &amp; Jerry

00:00:02.000 --> 00:00:03.000
中文
字幕
`;

describe("subtitle files", () => {
  it("parses SRT, dropping invalid spans and skipping empty cues", () => {
    const parsed = parseTimedSubtitle(SRT);
    expect(parsed.format).toBe("srt");
    expect(parsed.cues).toEqual([
      { startMs: 1000, endMs: 2500, text: "Hello world" },
      { startMs: 3000, endMs: 4000, text: "第二句" },
    ]);
    expect(parsed.droppedCues).toBe(1);
  });

  it("parses WebVTT with identifiers, settings, notes, short timestamps and entities", () => {
    const parsed = parseTimedSubtitle(VTT);
    expect(parsed.format).toBe("vtt");
    expect(parsed.cues).toEqual([
      { startMs: 1000, endMs: 2000, text: "Tom & Jerry" },
      { startMs: 2000, endMs: 3000, text: "中文字幕" },
    ]);
  });

  it("decides the format by content and rejects anything else", () => {
    expect(parseTimedSubtitle(`\uFEFF${SRT.replace(/\n/g, "\r\n")}`).format).toBe("srt");
    expect(codeOf(() => parseTimedSubtitle("just some notes\nwithout timing"))).toBe("invalid_request.subtitle_format");
    expect(codeOf(() => parseTimedSubtitle("WEBVTT\n\n00:00:02.000 --> 00:00:01.000\nbackwards\n"))).toBe("invalid_request.subtitle_format");
  });

  it("accepts UTF-8 only, without the BOM", () => {
    expect(decodeSubtitleText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("a");
    expect(codeOf(() => decodeSubtitleText(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3])))).toBe("invalid_request.subtitle_encoding");
  });

  it("builds an imported revision that satisfies the transcript invariants", () => {
    const newId = monotonicFactory();
    const revisionId = newId();
    const { revision, segments } = importedTranscript({
      revisionId,
      contentId: "c",
      language: "zh-CN",
      subtitle: parseTimedSubtitle(SRT),
      newId,
      createdAt: 1,
    });
    expect(revision).toMatchObject({ kind: "imported", timingFidelity: "segment_only", generation: { kind: "imported", format: "srt" }, segmentCount: 2 });
    expect(checkTranscriptInvariants(revision, segments)).toEqual([]);
  });
});

describe("canonicalLanguageTag", () => {
  it("canonicalizes the case of BCP-47 tags and rejects anything else", () => {
    expect(canonicalLanguageTag("zh-cn")).toBe("zh-CN");
    expect(canonicalLanguageTag("EN-us")).toBe("en-US");
    expect(canonicalLanguageTag("zh-hans-cn")).toBe("zh-Hans-CN");
    expect(canonicalLanguageTag("ja")).toBe("ja");
    for (const bad of ["", "e", "not a tag", "en_US", "zh-", "12"]) {
      expect(canonicalLanguageTag(bad)).toBeUndefined();
    }
  });
});
