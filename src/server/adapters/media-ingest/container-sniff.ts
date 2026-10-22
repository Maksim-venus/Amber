/**
 * Containers Amber accepts, recognized by their leading bytes and confirmed by ffprobe's
 * `format_name`. Extensions are never consulted.
 */
export interface ContainerFamily {
  id: string;
  /** Demuxer names ffprobe may report for this family; `format_name` must share one. */
  ffprobeFormats: readonly string[];
  mimeType(input: { hasVideo: boolean; head: Buffer }): string;
}

const ascii = (head: Buffer, offset: number, text: string): boolean =>
  head.length >= offset + text.length && head.toString("latin1", offset, offset + text.length) === text;

const FAMILIES: ReadonlyArray<ContainerFamily & { matches(head: Buffer): boolean }> = [
  {
    id: "isobmff",
    ffprobeFormats: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
    matches: (head) => ascii(head, 4, "ftyp"),
    mimeType: ({ hasVideo, head }) => (ascii(head, 8, "qt  ") ? "video/quicktime" : hasVideo ? "video/mp4" : "audio/mp4"),
  },
  {
    id: "matroska",
    ffprobeFormats: ["matroska", "webm"],
    matches: (head) => head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3,
    // The EBML header names the DocType within the first bytes.
    mimeType: ({ hasVideo, head }) =>
      head.includes("webm", 0, "latin1") ? (hasVideo ? "video/webm" : "audio/webm") : hasVideo ? "video/x-matroska" : "audio/x-matroska",
  },
  {
    id: "avi",
    ffprobeFormats: ["avi"],
    matches: (head) => ascii(head, 0, "RIFF") && ascii(head, 8, "AVI "),
    mimeType: () => "video/x-msvideo",
  },
  {
    id: "wav",
    ffprobeFormats: ["wav"],
    matches: (head) => ascii(head, 0, "RIFF") && ascii(head, 8, "WAVE"),
    mimeType: () => "audio/wav",
  },
  {
    id: "flv",
    ffprobeFormats: ["flv"],
    matches: (head) => ascii(head, 0, "FLV"),
    mimeType: () => "video/x-flv",
  },
  {
    id: "mpegts",
    ffprobeFormats: ["mpegts"],
    // Sync byte at the start of two consecutive 188-byte packets.
    matches: (head) => head.length > 188 && head[0] === 0x47 && head[188] === 0x47,
    mimeType: () => "video/mp2t",
  },
  {
    id: "mp3",
    ffprobeFormats: ["mp3"],
    matches: (head) => ascii(head, 0, "ID3") || (head.length >= 2 && head[0] === 0xff && ((head[1] as number) & 0xe0) === 0xe0),
    mimeType: () => "audio/mpeg",
  },
  {
    id: "flac",
    ffprobeFormats: ["flac"],
    matches: (head) => ascii(head, 0, "fLaC"),
    mimeType: () => "audio/flac",
  },
  {
    id: "ogg",
    ffprobeFormats: ["ogg"],
    matches: (head) => ascii(head, 0, "OggS"),
    mimeType: ({ hasVideo }) => (hasVideo ? "video/ogg" : "audio/ogg"),
  },
];

/** User-facing list for `media_unsupported_type`. */
export const SUPPORTED_FORMATS = "mp4, mov, m4a, mkv, webm, avi, flv, ts, mp3, wav, flac, ogg";

export function sniffContainer(head: Buffer): ContainerFamily | undefined {
  return FAMILIES.find((family) => family.matches(head));
}

/** ffprobe lists every demuxer alias, e.g. `mov,mp4,m4a,3gp,3g2,mj2`; one must belong to the family. */
export function formatMatchesFamily(formatName: string, family: ContainerFamily): boolean {
  return formatName.split(",").some((name) => family.ffprobeFormats.includes(name.trim()));
}
