import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { MEDIA_PROBE_TIMEOUT_MS, MEDIA_SNIFF_BYTES } from "../../../shared/defaults.ts";
import { amberError } from "../../domain/errors.ts";
import type { LocalMediaIngest, MediaProbe } from "../../ports/local-media-ingest.ts";
import type { ProcessResult, ProcessRunner, ProcessSpec } from "../../ports/process-runner.ts";
import { formatMatchesFamily, sniffContainer, SUPPORTED_FORMATS } from "./container-sniff.ts";

export interface FfmpegMediaIngestOptions {
  runner: ProcessRunner;
  /** Directory holding ffmpeg / ffprobe (`AMBER_BIN_DIR`); tools are always started by absolute path. */
  binDir: string;
  /** Complete child environment, built with `childProcessEnv`. */
  env: Readonly<Record<string, string>>;
}

interface FfprobeOutput {
  format?: { format_name?: string; duration?: string };
  streams?: Array<{ codec_type?: string; disposition?: { attached_pic?: number } }>;
}

const AUDIO_SAMPLE_RATE = 16_000;
/**
 * Mono speech at 64 kbit/s keeps MP3 clips well intelligible for a model while staying a
 * fraction of the size of the equivalent PCM WAV.
 */
const MP3_CLIP_BITRATE = "64k";

/** Encoder arguments per clip MIME type; anything else cannot be produced here. */
const CLIP_ENCODINGS: Readonly<Record<string, readonly string[]>> = {
  "audio/wav": ["-c:a", "pcm_s16le", "-f", "wav"],
  "audio/mpeg": ["-c:a", "libmp3lame", "-b:a", MP3_CLIP_BITRATE, "-f", "mp3"],
};

/** Milliseconds as ffmpeg's `seconds.fraction` time syntax, exact to the millisecond. */
const secondsOf = (ms: number): string => (ms / 1000).toFixed(3);

/** Machine-readable progress on stdout, without the human status line on stderr. */
const PROGRESS_ARGS = ["-progress", "pipe:1", "-nostats"] as const;

/**
 * A stdout line handler for `PROGRESS_ARGS` that reports the share of `durationMs`
 * written so far, only when it moves forward.
 */
function progressLineHandler(durationMs: number, onProgress: (progress: number) => void): (line: string) => void {
  let reported = 0;
  return (line) => {
    // `-progress` prints `out_time_us=<microseconds>` (`out_time_ms` is microseconds too, despite its name).
    const match = /^out_time_us=(\d+)$/u.exec(line.trim());
    if (match === null || durationMs <= 0) {
      return;
    }
    const progress = Math.min(1, Number(match[1]) / 1000 / durationMs);
    if (progress > reported) {
      reported = progress;
      onProgress(progress);
    }
  };
}

function unsupported(reason: string): Error {
  return amberError("media_unsupported_type", reason, { params: { formats: SUPPORTED_FORMATS } });
}

/** `file:` keeps a path that looks like a URL or an option from being read as one. */
const fileUrl = (path: string): string => `file:${path}`;

/** The input file is gone (moved or deleted outside Amber): `media_missing`, not a tool failure. */
async function openInput(path: string) {
  try {
    return await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw amberError("media_missing", "input file does not exist");
    }
    throw error;
  }
}

async function readHead(path: string): Promise<Buffer> {
  const handle = await openInput(path);
  try {
    const buffer = Buffer.alloc(MEDIA_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MEDIA_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function fingerprintOf(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) {
    hash.update(chunk as Buffer);
  }
  return `sha256:${hash.digest("hex")}`;
}

function durationMsOf(output: FfprobeOutput): number | undefined {
  const seconds = Number(output.format?.duration);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
}

/** LocalMediaIngest over the bundled ffprobe / ffmpeg. */
export class FfmpegMediaIngest implements LocalMediaIngest {
  private readonly options: FfmpegMediaIngestOptions;

  constructor(options: FfmpegMediaIngestOptions) {
    this.options = options;
  }

  async probe(path: string, signal: AbortSignal): Promise<MediaProbe> {
    const head = await readHead(path);
    const family = sniffContainer(head);
    if (family === undefined) {
      throw unsupported("leading bytes match no accepted container");
    }
    const output = await this.ffprobe(path, signal);
    if (output === undefined || !formatMatchesFamily(output.format?.format_name ?? "", family)) {
      throw unsupported(`ffprobe does not confirm ${family.id}`);
    }
    const durationMs = durationMsOf(output);
    if (durationMs === undefined) {
      throw unsupported("no usable duration");
    }
    // Cover art is stored as a video stream flagged `attached_pic`; it does not make a file a video.
    const streams = output.streams ?? [];
    const hasVideo = streams.some((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1);
    const hasAudio = streams.some((stream) => stream.codec_type === "audio");
    return {
      durationMs,
      hasAudio,
      mimeType: family.mimeType({ hasVideo, head }),
      fingerprint: await fingerprintOf(path, signal),
    };
  }

  async extractAudio(
    input: { path: string },
    output: { path: string },
    signal: AbortSignal,
    options?: { durationMs?: number; onProgress?: (progress: number) => void },
  ): Promise<{ sizeBytes: number; durationMs: number }> {
    await (await openInput(input.path)).close();
    const onProgress = options?.onProgress;
    // Progress is measured against the caller's duration hint; without one ffmpeg is not asked for it.
    const progressLine = onProgress === undefined || options?.durationMs === undefined ? undefined : progressLineHandler(options.durationMs, onProgress);
    const result = await this.run(
      "ffmpeg",
      [
        "-nostdin", "-v", "error", "-y",
        "-i", fileUrl(input.path),
        "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(AUDIO_SAMPLE_RATE), "-c:a", "flac",
        ...(progressLine === undefined ? [] : PROGRESS_ARGS),
        "-f", "flac", fileUrl(output.path),
      ],
      signal,
      undefined,
      progressLine,
    );
    if (result.exitCode !== 0) {
      if (/matches no streams/.test(result.stderr)) {
        throw amberError("media_no_audio", "input has no audio track");
      }
      throw amberError("internal", `ffmpeg exited with ${result.exitCode ?? result.signal}`, { code: "internal.tool_failed" });
    }
    const probed = await this.ffprobe(output.path, signal);
    const durationMs = probed === undefined ? undefined : durationMsOf(probed);
    if (durationMs === undefined) {
      throw amberError("internal", "extracted audio has no duration", { code: "internal.tool_failed" });
    }
    onProgress?.(1);
    return { sizeBytes: (await stat(output.path)).size, durationMs };
  }

  async transcodeAudio(
    input: { path: string },
    output: { path: string },
    options: { bitrateKbps: number },
    onProgress: (progress: number) => void,
    signal: AbortSignal,
  ): Promise<{ sizeBytes: number; durationMs?: number }> {
    if (!Number.isInteger(options.bitrateKbps) || options.bitrateKbps <= 0) {
      throw new TypeError(`invalid bitrate ${options.bitrateKbps}`);
    }
    await (await openInput(input.path)).close();
    const probed = await this.ffprobe(input.path, signal);
    const durationMs = probed === undefined ? undefined : durationMsOf(probed);
    const result = await this.run(
      "ffmpeg",
      [
        "-nostdin", "-v", "error", "-y",
        "-i", fileUrl(input.path),
        "-map", "0:a:0", "-vn", "-c:a", "libmp3lame", "-b:a", `${options.bitrateKbps}k`,
        ...PROGRESS_ARGS,
        "-f", "mp3", fileUrl(output.path),
      ],
      signal,
      undefined,
      durationMs === undefined ? undefined : progressLineHandler(durationMs, onProgress),
    );
    if (result.exitCode !== 0) {
      if (/matches no streams/.test(result.stderr)) {
        throw amberError("media_no_audio", "input has no audio track");
      }
      throw amberError("internal", `ffmpeg exited with ${result.exitCode ?? result.signal}`, { code: "internal.tool_failed" });
    }
    onProgress(1);
    return { sizeBytes: (await stat(output.path)).size, ...(durationMs === undefined ? {} : { durationMs }) };
  }

  async clipAudio(
    input: { path: string },
    output: { path: string },
    range: { startMs: number; endMs: number },
    mimeType: string,
    signal: AbortSignal,
  ): Promise<{ sizeBytes: number }> {
    if (!Number.isFinite(range.startMs) || !Number.isFinite(range.endMs) || range.startMs < 0 || range.endMs <= range.startMs) {
      throw new TypeError(`invalid clip range ${range.startMs}–${range.endMs}`);
    }
    const encoding = CLIP_ENCODINGS[mimeType.split(";")[0]?.trim().toLowerCase() ?? ""];
    if (encoding === undefined) {
      throw amberError("llm_capability", `cannot produce audio clips as ${mimeType}`);
    }
    await (await openInput(input.path)).close();
    // `-ss` before `-i` seeks the input; with `-t` the clip is cut sample-accurately for audio.
    const result = await this.run(
      "ffmpeg",
      [
        "-nostdin", "-v", "error", "-y",
        "-ss", secondsOf(range.startMs), "-t", secondsOf(range.endMs - range.startMs),
        "-i", fileUrl(input.path),
        "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(AUDIO_SAMPLE_RATE), ...encoding,
        fileUrl(output.path),
      ],
      signal,
    );
    if (result.exitCode !== 0) {
      if (/matches no streams/.test(result.stderr)) {
        throw amberError("media_no_audio", "input has no audio track");
      }
      throw amberError("internal", `ffmpeg exited with ${result.exitCode ?? result.signal}`, { code: "internal.tool_failed" });
    }
    return { sizeBytes: (await stat(output.path)).size };
  }

  /** `undefined` when ffprobe cannot read the file at all. */
  private async ffprobe(path: string, signal: AbortSignal): Promise<FfprobeOutput | undefined> {
    const result = await this.run(
      "ffprobe",
      [
        "-v", "error", "-print_format", "json",
        "-show_entries", "format=format_name,duration:stream=codec_type:stream_disposition=attached_pic",
        "-i", fileUrl(path),
      ],
      signal,
      MEDIA_PROBE_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) {
      return undefined;
    }
    try {
      return JSON.parse(result.stdout) as FfprobeOutput;
    } catch {
      return undefined;
    }
  }

  private async run(
    tool: "ffmpeg" | "ffprobe",
    args: readonly string[],
    signal: AbortSignal,
    timeoutMs?: number,
    onStdoutLine?: (line: string) => void,
  ): Promise<ProcessResult> {
    const spec: ProcessSpec = {
      command: join(this.options.binDir, process.platform === "win32" ? `${tool}.exe` : tool),
      args,
      env: this.options.env,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
    try {
      return await this.options.runner.run(spec, { signal, ...(onStdoutLine === undefined ? {} : { onStdoutLine }) });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      // The tool could not be started or timed out: not a property of the file.
      throw amberError("internal", `${tool} failed to run`, { code: "internal.tool_failed" });
    }
  }
}
