import { describe, expect, it } from "vitest";
import { collapseRollingCaptions } from "../../../../../src/server/adapters/platform/youtube/captions.ts";
import { parseTimedSubtitle } from "../../../../../src/server/domain/subtitle-file.ts";

// The shape of YouTube's automatic WebVTT: each cue repeats the previous line on top
// (the first cue has a blank-looking line of one space), and 10 ms "hold" cues carry
// only the already-shown line.
const ROLLING = [
  "WEBVTT",
  "Kind: captions",
  "Language: en",
  "",
  "00:00:00.000 --> 00:00:02.000 align:start position:0%",
  " ",
  "hello<00:00:00.500><c> everyone</c>",
  "",
  "00:00:02.000 --> 00:00:02.010 align:start position:0%",
  "hello everyone",
  " ",
  "",
  "00:00:02.010 --> 00:00:04.000 align:start position:0%",
  "hello everyone",
  "welcome<00:00:02.500><c> to</c><00:00:03.000><c> the</c><00:00:03.500><c> course</c>",
  "",
  "00:00:04.000 --> 00:00:04.010 align:start position:0%",
  "welcome to the course",
  " ",
  "",
  "00:00:04.010 --> 00:00:06.000 align:start position:0%",
  "welcome to the course",
  "today we start",
  "",
].join("\n");

describe("collapseRollingCaptions", () => {
  it("keeps each spoken line once, in the cue where it first appears", () => {
    const cues = parseTimedSubtitle(collapseRollingCaptions(ROLLING)).cues;
    expect(cues.map((cue) => [cue.startMs, cue.endMs, cue.text])).toEqual([
      [0, 2000, "hello everyone"],
      [2010, 4000, "welcome to the course"],
      [4010, 6000, "today we start"],
    ]);
  });

  it("keeps the header and leaves a caption without repeats unchanged", () => {
    const plain = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nfirst\n\n00:00:01.000 --> 00:00:02.000\nsecond";
    expect(collapseRollingCaptions(plain)).toBe(plain);
  });

  it("does not drop a line that is repeated later after something else was said", () => {
    const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nyes\n\n00:00:01.000 --> 00:00:02.000\nno\n\n00:00:02.000 --> 00:00:03.000\nyes";
    expect(parseTimedSubtitle(collapseRollingCaptions(vtt)).cues.map((cue) => cue.text)).toEqual(["yes", "no", "yes"]);
  });
});
