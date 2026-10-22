import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { MEDIA_PROBE_TIMEOUT_MS } from "../../../shared/defaults.ts";
import type { SubtitleVideoContainer } from "../../../shared/enums.ts";
import { incompatibleStreamDetail, mp4IncompatibleStreams, type MediaStreamInfo } from "../../domain/export/container-policy.ts";
import { amberError } from "../../domain/errors.ts";
import type { ProcessResult, ProcessRunner, ProcessSpec } from "../../ports/process-runner.ts";
import type { MediaInspection, SubtitleMuxer, SubtitleTrack } from "../../ports/subtitle-muxer.ts";

export interface FfmpegSubtitleMuxerOptions {
  runner: ProcessRunner;
  /** `AMBER_BIN_DIR`: ffmpeg and ffprobe are started by absolute path. */
  binDir: string;
  /** The bundled font embedded into MKV output, from the fonts directory beside `AMBER_BIN_DIR`. */
  fontPath: string;
  /** Complete child environment, built with `childProcessEnv`. */
  env: Readonly<Record<string, string>>;
}

interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  disposition?: { attached_pic?: number };
  side_data_list?: Array<{ side_data_type?: string; rotation?: number }>;
}

interface FfprobeOutput {
  format?: { format_name?: string; duration?: string };
  streams?: FfprobeStream[];
}

const STREAM_TYPES: ReadonlySet<string> = new Set(["video", "audio", "subtitle", "attachment"]);

/** `file:` keeps a path that looks like a URL or an option from being read as one. */
const fileUrl = (path: string): string => `file:${path}`;

/** `N:D` with both parts positive; `0:1` and `N/A` mean the file declares no ratio. */
function sarOf(text: string | undefined): { num: number; den: number } | undefined {
  const match = /^(\d+):(\d+)$/u.exec(text ?? "");
  const num = Number(match?.[1]);
  const den = Number(match?.[2]);
  return num > 0 && den > 0 ? { num, den } : undefined;
}

/** The display matrix rotation as 0, 90, 180 or 270 degrees. */
function rotationOf(stream: FfprobeStream): number | undefined {
  const matrix = stream.side_data_list?.find((entry) => entry.side_data_type === "Display Matrix" && typeof entry.rotation === "number");
  if (matrix?.rotation === undefined) {
    return undefined;
  }
  return (((Math.round(matrix.rotation / 90) * 90) % 360) + 360) % 360;
}

/** ffprobe's JSON as the port's stream facts; stream kinds beyond the four named ones are data. */
export function inspectionOf(output: FfprobeOutput): MediaInspection {
  const streams = (output.streams ?? []).map((stream, position): MediaStreamInfo => {
    const sar = sarOf(stream.sample_aspect_ratio);
    const rotation = rotationOf(stream);
    return {
      index: stream.index ?? position,
      type: STREAM_TYPES.has(stream.codec_type ?? "") ? (stream.codec_type as MediaStreamInfo["type"]) : "data",
      codec: stream.codec_name ?? "none",
      ...(stream.width === undefined ? {} : { width: stream.width }),
      ...(stream.height === undefined ? {} : { height: stream.height }),
      ...(sar === undefined ? {} : { sar }),
      ...(rotation === undefined ? {} : { rotation }),
      ...(stream.disposition?.attached_pic === 1 ? { attachedPic: true } : {}),
    };
  });
  return { container: output.format?.format_name ?? "", streams };
}

/** Options that write each subtitle track's language, title and default flag; only the first is ever default. */
export function trackMetadataArgs(tracks: readonly SubtitleTrack[]): string[] {
  return tracks.flatMap((track, index) => [
    `-metadata:s:s:${index}`, `language=${track.language}`,
    `-metadata:s:s:${index}`, `title=${track.title}`,
    `-disposition:s:${index}`, track.isDefault ? "default" : "0",
  ]);
}

async function assertReadable(path: string): Promise<void> {
  try {
    await (await open(path, "r")).close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw amberError("media_missing", "input file does not exist");
    }
    throw error;
  }
}

/**
 * SubtitleMuxer over the bundled ffmpeg / ffprobe. The output
 * is the `.partial` path of an atomic write, which has no extension, so the format is
 * always named with `-f`.
 */
export class FfmpegSubtitleMuxer implements SubtitleMuxer {
  private readonly options: FfmpegSubtitleMuxerOptions;
  private versionLine: Promise<string> | undefined;

  constructor(options: FfmpegSubtitleMuxerOptions) {
    this.options = options;
  }

  async inspect(video: string, signal: AbortSignal): Promise<MediaInspection> {
    return inspectionOf(await this.probe(video, signal));
  }

  async mux(
    input: { video: string; tracks: readonly SubtitleTrack[] },
    output: { path: string; container: SubtitleVideoContainer },
    onProgress: (progress: number) => void,
    signal: AbortSignal,
  ): Promise<{ sizeBytes: number }> {
    await assertReadable(input.video);
    for (const track of input.tracks) {
      await assertReadable(track.subtitle);
    }
    const probed = await this.probe(input.video, signal);
    if (output.container === "mp4") {
      // The rule is checked when the export is submitted; the file is checked again here
      // because the muxer is what would write an MP4 players cannot open.
      const incompatible = mp4IncompatibleStreams(inspectionOf(probed).streams);
      if (incompatible.length > 0) {
        throw amberError("invalid_request", "the video has streams an MP4 cannot carry", {
          code: "invalid_request.container_unsupported",
          details: { streams: incompatible.map(incompatibleStreamDetail) },
        });
      }
    } else {
      await assertReadable(this.options.fontPath);
    }
    const seconds = Number(probed.format?.duration);
    const durationMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
    const args = [
      "-hide_banner", "-nostdin", "-v", "error", "-nostats", "-progress", "pipe:1", "-y",
      "-i", fileUrl(input.video),
      ...input.tracks.flatMap((track) => ["-f", "ass", "-i", fileUrl(track.subtitle)]),
      "-map", "0:V", "-map", "0:a?",
      ...input.tracks.flatMap((_, index) => ["-map", String(index + 1)]),
      "-c", "copy", "-map_metadata", "0", "-map_chapters", "0",
      ...trackMetadataArgs(input.tracks),
      ...(output.container === "mkv"
        ? ["-attach", fileUrl(this.options.fontPath), "-metadata:s:t:0", "mimetype=font/otf", "-f", "matroska"]
        : ["-c:s", "mov_text", "-movflags", "+faststart", "-f", "mp4"]),
      fileUrl(output.path),
    ];
    const result = await this.run("ffmpeg", args, signal, undefined, (line) => {
      // ffmpeg reports `out_time_us` and, for compatibility, `out_time_ms` — both in microseconds.
      const match = /^out_time_(?:us|ms)=(\d+)$/u.exec(line.trim());
      if (match?.[1] !== undefined && durationMs !== undefined) {
        onProgress(Math.min(1, Number(match[1]) / 1000 / durationMs));
      }
    });
    if (result.exitCode !== 0) {
      throw amberError("internal", `ffmpeg exited with ${result.exitCode ?? result.signal}`, { code: "internal.tool_failed" });
    }
    onProgress(1);
    return { sizeBytes: (await stat(output.path)).size };
  }

  /** Read once per instance (one per process); a failed read is not cached. */
  version(signal: AbortSignal): Promise<string> {
    this.versionLine ??= this.run("ffmpeg", ["-hide_banner", "-nostdin", "-version"], signal, MEDIA_PROBE_TIMEOUT_MS).then((result) => {
      const line = result.stdout.split(/\r?\n/u)[0]?.trim() ?? "";
      if (result.exitCode !== 0 || line === "") {
        throw amberError("internal", "ffmpeg reports no version", { code: "internal.tool_failed" });
      }
      return line;
    });
    const reading = this.versionLine;
    reading.catch(() => {
      if (this.versionLine === reading) {
        this.versionLine = undefined;
      }
    });
    return reading;
  }

  private async probe(path: string, signal: AbortSignal): Promise<FfprobeOutput> {
    await assertReadable(path);
    const result = await this.run(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-i", fileUrl(path)],
      signal,
      MEDIA_PROBE_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) {
      throw amberError("internal", `ffprobe exited with ${result.exitCode ?? result.signal}`, { code: "internal.tool_failed" });
    }
    try {
      return JSON.parse(result.stdout) as FfprobeOutput;
    } catch {
      throw amberError("internal", "ffprobe printed no JSON", { code: "internal.tool_failed" });
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
      throw amberError("internal", `${tool} failed to run`, { code: "internal.tool_failed" });
    }
  }
}
