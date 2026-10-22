/** One stream of a media file as the subtitle muxer reports it. */
export interface MediaStreamInfo {
  index: number;
  type: "video" | "audio" | "subtitle" | "attachment" | "data";
  codec: string;
  width?: number;
  height?: number;
  /** Sample aspect ratio; absent when the file declares none (square pixels). */
  sar?: { num: number; den: number };
  /** Display rotation in degrees, normalized to 0, 90, 180 or 270. */
  rotation?: number;
  /** A cover image stored as a video stream. */
  attachedPic?: boolean;
}

/** A stream that keeps a file out of an MP4 soft-subtitle export. */
export interface IncompatibleStream {
  index: number;
  type: MediaStreamInfo["type"];
  codec: string;
}

const MP4_VIDEO_CODECS: ReadonlySet<string> = new Set(["h264"]);
const MP4_AUDIO_CODECS: ReadonlySet<string> = new Set(["aac", "mp3"]);

/**
 * The MP4 compatibility rule of a soft-subtitle export: video must be H.264
 * and audio AAC or MP3. ffmpeg would write VP9, Opus, FLAC or Vorbis into MP4 too, but
 * system players may not play them, so the rule is ours rather than ffmpeg's. Cover
 * images, subtitles, attachments and data streams are not carried over and never count.
 */
export function mp4IncompatibleStreams(streams: readonly MediaStreamInfo[]): IncompatibleStream[] {
  return streams
    .filter(
      (stream) =>
        (stream.type === "video" && stream.attachedPic !== true && !MP4_VIDEO_CODECS.has(stream.codec)) ||
        (stream.type === "audio" && !MP4_AUDIO_CODECS.has(stream.codec)),
    )
    .map(({ index, type, codec }) => ({ index, type, codec }));
}

/** `index:type:codec`, the wire form of `invalid_request.container_unsupported` `details.streams` entries. */
export function incompatibleStreamDetail(stream: IncompatibleStream): string {
  return `${stream.index}:${stream.type}:${stream.codec}`;
}

/** Audio codecs a re-encoded MP4 carries as they are; any other audio is converted to AAC. */
export function mp4CopiesAudio(codec: string): boolean {
  return MP4_AUDIO_CODECS.has(codec);
}
