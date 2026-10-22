import type { MediaStreamInfo } from "../domain/export/container-policy.ts";
import type { SubtitleVideoContainer } from "../../shared/enums.ts";

/** A media file's container and streams, read without decoding. */
export interface MediaInspection {
  /** The demuxer's format name list, e.g. `mov,mp4,m4a,3gp,3g2,mj2`. */
  container: string;
  streams: MediaStreamInfo[];
}

/** One subtitle track to add; tracks keep their order in the output. */
export interface SubtitleTrack {
  /** Path of an ASS file. */
  subtitle: string;
  /** ISO 639-2/T code, `mul` or `und`. */
  language: string;
  title: string;
  isDefault: boolean;
}

/**
 * Adds subtitle tracks to a video without re-encoding it:
 * all video streams but cover images, all audio, chapters and global metadata are copied;
 * the source's own subtitles, attachments and data streams are left out. MKV keeps the
 * styled ASS and embeds the bundled font; MP4 converts each track to `mov_text`.
 */
export interface SubtitleMuxer {
  /** Container and per-stream facts of a file. */
  inspect(video: string, signal: AbortSignal): Promise<MediaInspection>;
  mux(
    input: { video: string; tracks: readonly SubtitleTrack[] },
    output: { path: string; container: SubtitleVideoContainer },
    onProgress: (progress: number) => void,
    signal: AbortSignal,
  ): Promise<{ sizeBytes: number }>;
  /** The tool's version line: a different tool may write a different file from the same input. */
  version(signal: AbortSignal): Promise<string>;
}
