import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FfmpegSubtitleMuxer, inspectionOf, trackMetadataArgs } from "../../../../src/server/adapters/media-ingest/ffmpeg-subtitle-muxer.ts";
import { NodeProcessRunner } from "../../../../src/server/adapters/process-runner/node-process-runner.ts";
import { styledAssDocument } from "../../../../src/server/domain/export/ass.ts";
import { isAmberError } from "../../../../src/server/domain/errors.ts";
import { childProcessEnv } from "../../../../src/server/ports/process-runner.ts";
import type { SubtitleTrack } from "../../../../src/server/ports/subtitle-muxer.ts";
import { defaultSubtitleAppearance, defaultSubtitlePlacement } from "../../../../src/shared/subtitle-style.ts";
import { ScriptedRunner } from "../../../fixtures/platform/scripted-io.ts";
import { toolPath, toolsBinDir } from "../../../fixtures/tools.ts";
import { tempDataDir } from "../../../tools/sqlite.ts";

const signal = (): AbortSignal => new AbortController().signal;

const PROBE_JSON = {
  format: { format_name: "matroska,webm", duration: "2.000000" },
  streams: [
    { index: 0, codec_type: "video", codec_name: "h264", width: 721, height: 575, sample_aspect_ratio: "16:11", disposition: { attached_pic: 0 } },
    { index: 1, codec_type: "audio", codec_name: "flac", disposition: { attached_pic: 0 } },
    { index: 2, codec_type: "subtitle", codec_name: "subrip" },
    { index: 3, codec_type: "attachment", codec_name: "ttf" },
    { index: 4, codec_type: "video", codec_name: "mjpeg", width: 300, height: 300, sample_aspect_ratio: "0:1", disposition: { attached_pic: 1 } },
    { index: 5, codec_type: "data", codec_name: "bin_data" },
    { index: 6, codec_type: "video", codec_name: "hevc", width: 1280, height: 720, side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] },
  ],
};

describe("inspectionOf", () => {
  it("reads codecs, sizes, sample aspect ratio, rotation and cover images from ffprobe's JSON", () => {
    expect(inspectionOf(PROBE_JSON)).toEqual({
      container: "matroska,webm",
      streams: [
        { index: 0, type: "video", codec: "h264", width: 721, height: 575, sar: { num: 16, den: 11 } },
        { index: 1, type: "audio", codec: "flac" },
        { index: 2, type: "subtitle", codec: "subrip" },
        { index: 3, type: "attachment", codec: "ttf" },
        { index: 4, type: "video", codec: "mjpeg", width: 300, height: 300, attachedPic: true },
        { index: 5, type: "data", codec: "bin_data" },
        { index: 6, type: "video", codec: "hevc", width: 1280, height: 720, rotation: 270 },
      ],
    });
  });
});

describe("trackMetadataArgs", () => {
  it("writes language, title and the default flag of each subtitle track", () => {
    const tracks: SubtitleTrack[] = [
      { subtitle: "/t/1.ass", language: "mul", title: "Amber 双语", isDefault: true },
      { subtitle: "/t/2.ass", language: "zho", title: "Amber 原文", isDefault: false },
    ];
    expect(trackMetadataArgs(tracks)).toEqual([
      "-metadata:s:s:0", "language=mul", "-metadata:s:s:0", "title=Amber 双语", "-disposition:s:0", "default",
      "-metadata:s:s:1", "language=zho", "-metadata:s:s:1", "title=Amber 原文", "-disposition:s:1", "0",
    ]);
  });
});

describe("FfmpegSubtitleMuxer with a scripted ffmpeg", () => {
  function setup(probe: object = PROBE_JSON) {
    const dir = tempDataDir("amber-muxer-");
    const video = join(dir, "in.mkv");
    const subtitle = join(dir, "track-1.ass");
    const font = join(dir, "font.otf");
    for (const path of [video, subtitle, font]) writeFileSync(path, "x");
    const runner = new ScriptedRunner((spec) => {
      if (spec.command.endsWith("ffprobe")) {
        return { stdout: JSON.stringify(probe) };
      }
      if (spec.args.includes("-version")) {
        return { stdout: "ffmpeg version n9.0.2 Copyright (c) 2000-2026 the FFmpeg developers\nbuilt with gcc\n" };
      }
      writeFileSync((spec.args.at(-1) as string).replace(/^file:/u, ""), "muxed");
      return { stdoutLines: ["out_time_us=1000000", "progress=end"] };
    });
    const muxer = new FfmpegSubtitleMuxer({ runner, binDir: "/opt/amber/bin", fontPath: font, env: {} });
    return { dir, video, subtitle, font, runner, muxer };
  }

  it("maps video without covers, all audio and each track, copies streams and metadata, and attaches the font to MKV", async () => {
    const { dir, video, subtitle, font, runner, muxer } = setup();
    const progress: number[] = [];
    const tracks: SubtitleTrack[] = [{ subtitle, language: "zho", title: "Amber 原文", isDefault: true }];
    const result = await muxer.mux({ video, tracks }, { path: join(dir, "out.partial"), container: "mkv" }, (value) => progress.push(value), signal());
    expect(result).toEqual({ sizeBytes: 5 });
    expect(progress).toEqual([0.5, 1]);
    const args = (runner.specs.at(-1)?.args ?? []).join(" ");
    expect(args).toContain(`-i file:${video} -f ass -i file:${subtitle} -map 0:V -map 0:a? -map 1 -c copy -map_metadata 0 -map_chapters 0`);
    expect(args).toContain("-metadata:s:s:0 language=zho -metadata:s:s:0 title=Amber 原文 -disposition:s:0 default");
    expect(args.endsWith(`-attach file:${font} -metadata:s:t:0 mimetype=font/otf -f matroska file:${join(dir, "out.partial")}`)).toBe(true);
  });

  it("converts tracks to mov_text for MP4 and refuses a source outside the MP4 rule", async () => {
    const compatible = { format: { format_name: "mov,mp4", duration: "2" }, streams: [{ index: 0, codec_type: "video", codec_name: "h264", width: 2, height: 2 }, { index: 1, codec_type: "audio", codec_name: "aac" }] };
    const ok = setup(compatible);
    const tracks: SubtitleTrack[] = [{ subtitle: ok.subtitle, language: "eng", title: "t", isDefault: true }];
    await ok.muxer.mux({ video: ok.video, tracks }, { path: join(ok.dir, "out.partial"), container: "mp4" }, () => undefined, signal());
    expect((ok.runner.specs.at(-1)?.args ?? []).join(" ")).toContain("-c:s mov_text -movflags +faststart -f mp4 file:");
    expect(ok.runner.specs.at(-1)?.args).not.toContain("-attach");

    const bad = setup();
    const failure = await bad.muxer.mux({ video: bad.video, tracks }, { path: join(bad.dir, "out.partial"), container: "mp4" }, () => undefined, signal()).catch((error: unknown) => error);
    expect(isAmberError(failure) && failure.appError).toMatchObject({ code: "invalid_request.container_unsupported", details: { streams: ["1:audio:flac", "6:video:hevc"] } });
    expect(bad.runner.specs.filter((spec) => spec.command.endsWith("ffmpeg"))).toEqual([]);
  });

  it("reads the version line once, and a missing input is media_missing", async () => {
    const { dir, subtitle, runner, muxer } = setup();
    expect(await muxer.version(signal())).toBe("ffmpeg version n9.0.2 Copyright (c) 2000-2026 the FFmpeg developers");
    await muxer.version(signal());
    expect(runner.specs.filter((spec) => spec.args.includes("-version"))).toHaveLength(1);
    const missing = await muxer
      .mux({ video: join(dir, "gone.mkv"), tracks: [{ subtitle, language: "und", title: "t", isDefault: true }] }, { path: join(dir, "o.partial"), container: "mkv" }, () => undefined, signal())
      .catch((error: unknown) => error);
    expect(isAmberError(missing) && missing.appError.class).toBe("media_missing");
    const inspected = await muxer.inspect(join(dir, "gone.mkv"), signal()).catch((error: unknown) => error);
    expect(isAmberError(inspected) && inspected.appError.class).toBe("media_missing");
    expect(runner.specs.filter((spec) => spec.command.endsWith("ffprobe"))).toEqual([]);
  });
});

/** Runs the pinned ffmpeg to make a source file. */
function ffmpeg(args: readonly string[]): void {
  const run = spawnSync(toolPath("ffmpeg"), ["-nostdin", "-v", "error", "-y", ...args], { encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
}

interface ProbedStream {
  index: number;
  codec_type: string;
  codec_name?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
}

function probeStreams(path: string): ProbedStream[] {
  const run = spawnSync(toolPath("ffprobe"), ["-v", "error", "-print_format", "json", "-show_streams", `file:${path}`], { encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
  return (JSON.parse(run.stdout) as { streams: ProbedStream[] }).streams;
}

describe("FfmpegSubtitleMuxer with the pinned ffmpeg", () => {
  function realMuxer() {
    const binDir = toolsBinDir();
    return new FfmpegSubtitleMuxer({ runner: new NodeProcessRunner(), binDir, fontPath: join(binDir, "..", "fonts", "NotoSansSC-Regular.otf"), env: childProcessEnv(process.env) });
  }

  function styledTracks(dir: string, textOnly: boolean): SubtitleTrack[] {
    const style = {
      appearance: { ...defaultSubtitleAppearance(), background: { ...defaultSubtitleAppearance().background, enabled: true } },
      placement: defaultSubtitlePlacement(),
    };
    const cues = [{ startMs: 0, endMs: 1500, original: "你好", translation: "Hello" }];
    const write = (name: string, content: string) => {
      const path = join(dir, name);
      writeFileSync(path, content);
      return path;
    };
    const options = { style, playRes: { width: 1920, height: 1080 }, textOnly };
    return [
      { subtitle: write("track-1.ass", styledAssDocument(cues, { ...options, mode: "bilingual" })), language: "mul", title: "Amber 双语", isDefault: true },
      { subtitle: write("track-2.ass", styledAssDocument([{ startMs: 0, endMs: 1500, original: "你好" }], { ...options, mode: "original" })), language: "zho", title: "Amber 原文", isDefault: false },
      { subtitle: write("track-3.ass", styledAssDocument([{ startMs: 0, endMs: 1500, translation: "Hello" }], { ...options, mode: "translation" })), language: "eng", title: "Amber 译文", isDefault: false },
    ];
  }

  /**
   * A source with its own subtitle track and a cover image, plus a text attachment in MKV,
   * none of which may be carried over. MKV keeps a cover as an image attachment, MP4 as an
   * `attached_pic` video stream; ffprobe reports both as the latter.
   */
  function source(dir: string, container: "mkv" | "mp4", audio: "aac" | "flac" = "aac"): string {
    const srt = join(dir, "own.srt");
    writeFileSync(srt, "1\n00:00:00,000 --> 00:00:01,000\nold\n");
    const cover = join(dir, "cover.png");
    ffmpeg(["-f", "lavfi", "-i", "color=c=red:size=64x64", "-frames:v", "1", cover]);
    const path = join(dir, `source.${container}`);
    const inputs = ["-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-i", srt];
    const encode = ["-c:v:0", "libx264", "-pix_fmt", "yuv420p", "-c:a", audio];
    ffmpeg(
      container === "mkv"
        ? [...inputs, "-map", "0", "-map", "1", "-map", "2", ...encode, "-c:s", "srt",
            "-attach", cover, "-metadata:s:t:0", "mimetype=image/png", "-attach", join(toolsBinDir(), "..", "fonts", "OFL.txt"), "-metadata:s:t:1", "mimetype=text/plain", "-t", "2", path]
        : [...inputs, "-i", cover, "-map", "0", "-map", "1", "-map", "2", "-map", "3", ...encode, "-c:v:1", "mjpeg", "-disposition:v:1", "attached_pic", "-c:s", "mov_text", "-t", "2", path],
    );
    return path;
  }

  it("writes MKV to an extensionless partial path with three tracks, one default, the bundled font, and nothing else of the source", async () => {
    const dir = tempDataDir("amber-muxer-mkv-");
    const video = source(dir, "mkv");
    const before = await realMuxer().inspect(video, signal());
    expect(before.streams.map((stream) => stream.type)).toEqual(expect.arrayContaining(["video", "audio", "subtitle", "attachment"]));
    expect(before.streams.some((stream) => stream.attachedPic === true)).toBe(true);

    const out = join(dir, "out.partial");
    const progress: number[] = [];
    const result = await realMuxer().mux({ video, tracks: styledTracks(dir, false) }, { path: out, container: "mkv" }, (value) => progress.push(value), signal());
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(1);
    const streams = probeStreams(out);
    expect(streams.map((stream) => `${stream.codec_type}:${stream.codec_name ?? ""}`)).toEqual([
      // ffprobe names no codec for an OpenType attachment; its mime type identifies it.
      "video:h264", "audio:aac", "subtitle:ass", "subtitle:ass", "subtitle:ass", "attachment:",
    ]);
    const subtitles = streams.filter((stream) => stream.codec_type === "subtitle");
    expect(subtitles.map((stream) => stream.tags?.["language"])).toEqual(["mul", "zho", "eng"]);
    expect(subtitles.map((stream) => stream.tags?.["title"])).toEqual(["Amber 双语", "Amber 原文", "Amber 译文"]);
    expect(subtitles.map((stream) => stream.disposition?.["default"])).toEqual([1, 0, 0]);
    expect(streams.at(-1)?.tags).toMatchObject({ mimetype: "font/otf", filename: "NotoSansSC-Regular.otf" });
  }, 60_000);

  it("writes MP4 with mov_text tracks, the languages kept and one default, without the cover or the old track", async () => {
    const dir = tempDataDir("amber-muxer-mp4-");
    const video = source(dir, "mp4");
    const before = await realMuxer().inspect(video, signal());
    expect(before.streams.filter((stream) => stream.attachedPic === true)).toHaveLength(1);
    expect(before.streams.some((stream) => stream.type === "subtitle")).toBe(true);
    const out = join(dir, "out.partial");
    await realMuxer().mux({ video, tracks: styledTracks(dir, true) }, { path: out, container: "mp4" }, () => undefined, signal());
    const streams = probeStreams(out);
    expect(streams.map((stream) => `${stream.codec_type}:${stream.codec_name ?? ""}`)).toEqual(["video:h264", "audio:aac", "subtitle:mov_text", "subtitle:mov_text", "subtitle:mov_text"]);
    const subtitles = streams.filter((stream) => stream.codec_type === "subtitle");
    expect(subtitles.map((stream) => stream.tags?.["language"])).toEqual(["mul", "zho", "eng"]);
    expect(subtitles.map((stream) => stream.disposition?.["default"])).toEqual([1, 0, 0]);
  }, 60_000);

  it("refuses an MP4 of a FLAC source as container_unsupported", async () => {
    const dir = tempDataDir("amber-muxer-flac-");
    const video = source(dir, "mkv", "flac");
    const failure = await realMuxer()
      .mux({ video, tracks: styledTracks(dir, true) }, { path: join(dir, "out.partial"), container: "mp4" }, () => undefined, signal())
      .catch((error: unknown) => error);
    expect(isAmberError(failure) && failure.appError.details).toEqual({ streams: ["1:audio:flac"] });
  }, 60_000);
});
