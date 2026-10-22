import { describe, expect, it } from "vitest";
import { formatMatchesFamily, sniffContainer } from "../../../../src/server/adapters/media-ingest/container-sniff.ts";

const bytes = (...parts: Array<string | number[]>): Buffer =>
  Buffer.concat(parts.map((part) => (typeof part === "string" ? Buffer.from(part, "latin1") : Buffer.from(part))));

describe("sniffContainer", () => {
  it("recognizes each accepted container by its leading bytes", () => {
    const cases: Array<[string, Buffer]> = [
      ["isobmff", bytes([0, 0, 0, 0x20], "ftypisom")],
      ["matroska", bytes([0x1a, 0x45, 0xdf, 0xa3], "....webm")],
      ["avi", bytes("RIFF", [0, 0, 0, 0], "AVI LIST")],
      ["wav", bytes("RIFF", [0, 0, 0, 0], "WAVEfmt ")],
      ["flv", bytes("FLV", [1])],
      ["mpegts", Buffer.concat([bytes([0x47]), Buffer.alloc(187), bytes([0x47]), Buffer.alloc(10)])],
      ["mp3", bytes("ID3", [4, 0])],
      ["mp3", bytes([0xff, 0xfb, 0x90])],
      ["flac", bytes("fLaC")],
      ["ogg", bytes("OggS")],
    ];
    for (const [id, head] of cases) {
      expect(sniffContainer(head)?.id, id).toBe(id);
    }
  });

  it("rejects text and images whatever their extension claims", () => {
    expect(sniffContainer(Buffer.from("hello, this is a text file renamed to .mp4"))).toBeUndefined();
    expect(sniffContainer(bytes([0x89], "PNG\r\n"))).toBeUndefined();
    expect(sniffContainer(Buffer.alloc(0))).toBeUndefined();
  });

  it("matches ffprobe format names by comma-separated family members", () => {
    const isobmff = sniffContainer(bytes([0, 0, 0, 0x20], "ftypM4A "));
    expect(isobmff).toBeDefined();
    expect(formatMatchesFamily("mov,mp4,m4a,3gp,3g2,mj2", isobmff!)).toBe(true);
    expect(formatMatchesFamily("aac", isobmff!)).toBe(false);
    expect(isobmff!.mimeType({ hasVideo: false, head: bytes([0, 0, 0, 0x20], "ftypM4A ") })).toBe("audio/mp4");
    expect(isobmff!.mimeType({ hasVideo: true, head: bytes([0, 0, 0, 0x20], "ftypqt  ") })).toBe("video/quicktime");
  });
});
