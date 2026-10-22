import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FfmpegMediaIngest } from "../../../../src/server/adapters/media-ingest/ffmpeg-media-ingest.ts";
import { NodeProcessRunner } from "../../../../src/server/adapters/process-runner/node-process-runner.ts";
import { isAmberError } from "../../../../src/server/domain/errors.ts";
import { childProcessEnv } from "../../../../src/server/ports/process-runner.ts";
import { mediaFixtures } from "../../../fixtures/media/index.ts";
import { toolPath, toolsBinDir } from "../../../fixtures/tools.ts";
import { tempDataDir } from "../../../tools/sqlite.ts";

const ingest = (): FfmpegMediaIngest =>
  new FfmpegMediaIngest({ runner: new NodeProcessRunner(), binDir: toolsBinDir(), env: childProcessEnv(process.env) });
const signal = (): AbortSignal => new AbortController().signal;

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isAmberError(error)) {
      return error.appError.code;
    }
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("FfmpegMediaIngest", () => {
  it("probes duration, audio track, container and fingerprint of each fixture", async () => {
    for (const [name, fixture] of Object.entries(mediaFixtures())) {
      const probe = await ingest().probe(fixture.path, signal());
      expect(Math.abs(probe.durationMs - fixture.meta.durationMs), name).toBeLessThanOrEqual(100);
      expect(probe.hasAudio, name).toBe(fixture.meta.hasAudio);
      expect(probe.mimeType, name).toBe(fixture.meta.mimeType);
      expect(probe.fingerprint).toBe(`sha256:${createHash("sha256").update(readFileSync(fixture.path)).digest("hex")}`);
    }
  });

  it("rejects a text file whatever its extension", async () => {
    const path = join(tempDataDir("amber-ingest-"), "notes.mp4");
    writeFileSync(path, "this is plain text pretending to be a video\n".repeat(20));
    expect(await codeOf(ingest().probe(path, signal()))).toBe("media_unsupported_type");
  });

  it("rejects a file whose leading bytes pass but ffprobe cannot parse", async () => {
    const path = join(tempDataDir("amber-ingest-"), "broken.flac");
    writeFileSync(path, Buffer.concat([Buffer.from("fLaC"), Buffer.alloc(64)]));
    expect(await codeOf(ingest().probe(path, signal()))).toBe("media_unsupported_type");
  });

  it("extracts mono 16 kHz FLAC that ffprobe recognizes", async () => {
    const { withAudio } = mediaFixtures();
    const output = join(tempDataDir("amber-ingest-"), "audio.partial");
    const result = await ingest().extractAudio({ path: withAudio.path }, { path: output }, signal());
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(Math.abs(result.durationMs - withAudio.meta.durationMs)).toBeLessThanOrEqual(100);
    const probed = spawnSync(
      toolPath("ffprobe"),
      ["-v", "error", "-print_format", "json", "-show_entries", "format=format_name:stream=codec_name,channels,sample_rate", "-i", `file:${output}`],
      { encoding: "utf8" },
    );
    const json = JSON.parse(probed.stdout) as { format: { format_name: string }; streams: Array<{ codec_name: string; channels: number; sample_rate: string }> };
    expect(json.format.format_name).toBe("flac");
    expect(json.streams).toEqual([{ codec_name: "flac", channels: 1, sample_rate: "16000" }]);
  });

  it("reports extraction progress against the duration hint from ffmpeg's out_time, ending at 1", async () => {
    const { withAudio } = mediaFixtures();
    const output = join(tempDataDir("amber-ingest-"), "audio.partial");
    const progress: number[] = [];
    // Twice the real duration: what ffmpeg wrote can only reach about half of it, so a value
    // near 0.5 proves `out_time_us` was parsed rather than only the final report.
    await ingest().extractAudio({ path: withAudio.path }, { path: output }, signal(), {
      durationMs: withAudio.meta.durationMs * 2,
      onProgress: (value) => progress.push(value),
    });
    expect(progress.some((value) => value > 0.4 && value < 0.6)).toBe(true);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it("reports only completion when extraction has no duration hint", async () => {
    const output = join(tempDataDir("amber-ingest-"), "audio.partial");
    const progress: number[] = [];
    await ingest().extractAudio({ path: mediaFixtures().withAudio.path }, { path: output }, signal(), { onProgress: (value) => progress.push(value) });
    expect(progress).toEqual([1]);
  });

  it("fails extraction of a file without audio with media_no_audio", async () => {
    const output = join(tempDataDir("amber-ingest-"), "audio.partial");
    expect(await codeOf(ingest().extractAudio({ path: mediaFixtures().noAudio.path }, { path: output }, signal()))).toBe("media_no_audio");
  });

  describe("clipAudio", () => {
    const extracted = async (): Promise<string> => {
      const path = join(tempDataDir("amber-ingest-"), "audio.flac");
      await ingest().extractAudio({ path: mediaFixtures().withAudio.path }, { path }, signal());
      return path;
    };
    const probeClip = (path: string) => {
      const probed = spawnSync(
        toolPath("ffprobe"),
        ["-v", "error", "-print_format", "json", "-show_entries", "format=format_name,duration:stream=codec_name,channels,sample_rate", "-i", `file:${path}`],
        { encoding: "utf8" },
      );
      return JSON.parse(probed.stdout) as {
        format: { format_name: string; duration: string };
        streams: Array<{ codec_name: string; channels: number; sample_rate: string }>;
      };
    };

    it("cuts the range as mono 16 kHz PCM WAV, written to a path without an extension", async () => {
      const output = join(tempDataDir("amber-ingest-"), "clip.partial");
      const result = await ingest().clipAudio({ path: await extracted() }, { path: output }, { startMs: 500, endMs: 2000 }, "audio/wav", signal());
      const json = probeClip(output);
      expect(json.format.format_name).toBe("wav");
      expect(json.streams).toEqual([{ codec_name: "pcm_s16le", channels: 1, sample_rate: "16000" }]);
      expect(Math.abs(Number(json.format.duration) * 1000 - 1500)).toBeLessThanOrEqual(20);
      expect(result.sizeBytes).toBe(readFileSync(output).length);
    });

    it("cuts the range as mono MP3", async () => {
      const output = join(tempDataDir("amber-ingest-"), "clip.partial");
      await ingest().clipAudio({ path: await extracted() }, { path: output }, { startMs: 1000, endMs: 2500 }, "audio/mpeg", signal());
      const json = probeClip(output);
      expect(json.format.format_name).toBe("mp3");
      expect(json.streams).toEqual([{ codec_name: "mp3", channels: 1, sample_rate: "16000" }]);
      // MP3 frames and encoder padding blur the edges by a few tens of milliseconds.
      expect(Math.abs(Number(json.format.duration) * 1000 - 1500)).toBeLessThanOrEqual(100);
    });

    it("refuses formats it cannot produce with llm_capability, and invalid ranges", async () => {
      const input = { path: await extracted() };
      const output = { path: join(tempDataDir("amber-ingest-"), "clip.partial") };
      expect(await codeOf(ingest().clipAudio(input, output, { startMs: 0, endMs: 1000 }, "audio/ogg", signal()))).toBe("llm_capability");
      await expect(ingest().clipAudio(input, output, { startMs: 1000, endMs: 1000 }, "audio/wav", signal())).rejects.toThrow(TypeError);
      await expect(ingest().clipAudio(input, output, { startMs: -1, endMs: 1000 }, "audio/wav", signal())).rejects.toThrow(TypeError);
    });

    it("stops when cancelled", async () => {
      const input = { path: await extracted() };
      const controller = new AbortController();
      controller.abort(new Error("cancelled"));
      const output = { path: join(tempDataDir("amber-ingest-"), "clip.partial") };
      const outcome = await ingest().clipAudio(input, output, { startMs: 0, endMs: 1000 }, "audio/wav", controller.signal).then(
        () => "resolved",
        (error: unknown) => (isAmberError(error) ? error.appError.code : "aborted"),
      );
      expect(outcome).toBe("aborted");
    });
  });

  describe("transcodeAudio", () => {
    const probeMp3 = (path: string) => {
      const probed = spawnSync(
        toolPath("ffprobe"),
        ["-v", "error", "-print_format", "json", "-show_entries", "format=format_name,duration,bit_rate:stream=codec_type,codec_name", "-i", `file:${path}`],
        { encoding: "utf8" },
      );
      return JSON.parse(probed.stdout) as { format: { format_name: string; duration: string; bit_rate: string }; streams: Array<{ codec_type: string; codec_name: string }> };
    };

    it("re-encodes the audio of a video as constant-bitrate MP3 to a path without an extension, with rising progress", async () => {
      const { withAudio } = mediaFixtures();
      const output = join(tempDataDir("amber-ingest-"), "第 1 讲.mp3.partial");
      const progress: number[] = [];
      const result = await ingest().transcodeAudio({ path: withAudio.path }, { path: output }, { bitrateKbps: 128 }, (value) => progress.push(value), signal());
      const json = probeMp3(output);
      expect(json.format.format_name).toBe("mp3");
      expect(json.streams).toEqual([{ codec_type: "audio", codec_name: "mp3" }]);
      expect(Math.abs(Number(json.format.bit_rate) / 1000 - 128)).toBeLessThanOrEqual(8);
      expect(Math.abs(Number(json.format.duration) * 1000 - withAudio.meta.durationMs)).toBeLessThanOrEqual(100);
      expect(result.sizeBytes).toBe(readFileSync(output).length);
      expect(Math.abs((result.durationMs ?? 0) - withAudio.meta.durationMs)).toBeLessThanOrEqual(100);
      expect(progress.at(-1)).toBe(1);
      expect(progress).toEqual([...progress].sort((a, b) => a - b));
      expect(progress.every((value) => value > 0 && value <= 1)).toBe(true);
    });

    it("transcodes an audio-only input too", async () => {
      const output = join(tempDataDir("amber-ingest-"), "audio.partial");
      await ingest().transcodeAudio({ path: mediaFixtures().audioOnly.path }, { path: output }, { bitrateKbps: 128 }, () => undefined, signal());
      expect(probeMp3(output).format.format_name).toBe("mp3");
    });

    it("fails a video without audio with media_no_audio and refuses a bitrate that is not a positive integer", async () => {
      const output = { path: join(tempDataDir("amber-ingest-"), "audio.partial") };
      expect(await codeOf(ingest().transcodeAudio({ path: mediaFixtures().noAudio.path }, output, { bitrateKbps: 128 }, () => undefined, signal()))).toBe("media_no_audio");
      for (const bitrateKbps of [0, -1, 1.5]) {
        await expect(ingest().transcodeAudio({ path: mediaFixtures().withAudio.path }, output, { bitrateKbps }, () => undefined, signal())).rejects.toThrow(TypeError);
      }
    });

    it("stops when cancelled", async () => {
      const controller = new AbortController();
      controller.abort(new Error("cancelled"));
      const output = { path: join(tempDataDir("amber-ingest-"), "audio.partial") };
      const outcome = await ingest().transcodeAudio({ path: mediaFixtures().withAudio.path }, output, { bitrateKbps: 128 }, () => undefined, controller.signal).then(
        () => "resolved",
        (error: unknown) => (isAmberError(error) ? error.appError.code : "aborted"),
      );
      expect(outcome).toBe("aborted");
    });
  });

  it("reports a tool that cannot start as internal.tool_failed", async () => {
    const broken = new FfmpegMediaIngest({ runner: new NodeProcessRunner(), binDir: tempDataDir("amber-nobin-"), env: {} });
    expect(await codeOf(broken.probe(mediaFixtures().withAudio.path, signal()))).toBe("internal.tool_failed");
  });
});
