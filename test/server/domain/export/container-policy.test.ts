import { describe, expect, it } from "vitest";
import { incompatibleStreamDetail, mp4CopiesAudio, mp4IncompatibleStreams, type MediaStreamInfo } from "../../../../src/server/domain/export/container-policy.ts";

describe("mp4IncompatibleStreams", () => {
  it("accepts H.264 with AAC or MP3", () => {
    const streams: MediaStreamInfo[] = [
      { index: 0, type: "video", codec: "h264", width: 1280, height: 720 },
      { index: 1, type: "audio", codec: "aac" },
      { index: 2, type: "audio", codec: "mp3" },
    ];
    expect(mp4IncompatibleStreams(streams)).toEqual([]);
  });

  it("lists every other video or audio stream, ignoring cover images, subtitles, attachments and data", () => {
    const streams: MediaStreamInfo[] = [
      { index: 0, type: "video", codec: "vp9", width: 1920, height: 1080 },
      { index: 1, type: "audio", codec: "opus" },
      { index: 2, type: "audio", codec: "flac" },
      { index: 3, type: "subtitle", codec: "ass" },
      { index: 4, type: "attachment", codec: "ttf" },
      { index: 5, type: "data", codec: "none" },
      { index: 6, type: "video", codec: "mjpeg", attachedPic: true },
      { index: 7, type: "audio", codec: "vorbis" },
    ];
    const incompatible = mp4IncompatibleStreams(streams);
    expect(incompatible).toEqual([
      { index: 0, type: "video", codec: "vp9" },
      { index: 1, type: "audio", codec: "opus" },
      { index: 2, type: "audio", codec: "flac" },
      { index: 7, type: "audio", codec: "vorbis" },
    ]);
    expect(incompatible.map(incompatibleStreamDetail)).toEqual(["0:video:vp9", "1:audio:opus", "2:audio:flac", "7:audio:vorbis"]);
  });

  it("copies only AAC and MP3 into a re-encoded MP4", () => {
    expect(["aac", "mp3", "flac", "opus"].map(mp4CopiesAudio)).toEqual([true, true, false, false]);
  });
});
