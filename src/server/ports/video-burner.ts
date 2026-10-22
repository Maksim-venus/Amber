/**
 * How a styled burn treats the picture and the audio. The
 * adapter derives its own filters and codec options from these facts.
 */
export interface BurnOptions {
  /**
   * The source's display geometry: with a non-square sample aspect ratio or odd dimensions
   * the picture is first scaled to square pixels with even dimensions, so the encoder
   * accepts it and the ASS canvas matches what is shown.
   */
  geometry?: { sar: { num: number; den: number }; displayWidth: number; displayHeight: number };
  /** Per audio stream, in order: copy it as is, or re-encode it to AAC. */
  audioCopy?: readonly boolean[];
}

/**
 * Burns an ASS subtitle file into a video. The encoder
 * is probed at run time in the order `h264_nvenc → h264_qsv → h264_vaapi →
 * h264_videotoolbox → libx264`; one that is listed but fails to encode makes the next one
 * run. Fonts come only from the bundled fonts directory. Without `options` the command is
 * the fixed legacy one: every stream ffmpeg picks by default, audio copied.
 */
export interface VideoBurner {
  burn(
    input: { video: string; subtitle: string },
    output: { path: string },
    onProgress: (progress: number) => void,
    signal: AbortSignal,
    options?: BurnOptions,
  ): Promise<{ sizeBytes: number; encoder: string }>;
}
