import { crc32, inflateRawSync } from "node:zlib";

/**
 * Minimal reader for the upstream release archives (Node, Deno, FFmpeg for Windows).
 * Supports stored and deflated entries in classic (non-ZIP64) archives and checks each
 * entry's CRC-32, so extraction behaves the same on Linux and Windows without relying on
 * whichever unzip tool the host happens to have.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;
const ZIP64_MARKER = 0xffffffff;

export interface ZipEntry {
  name: string;
  compressedSize: number;
  size: number;
  read(): Buffer;
}

export function readZip(archive: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(archive);
  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  if (offset === ZIP64_MARKER) {
    throw new Error("ZIP64 archives are not supported");
  }
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index++) {
    if (archive.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error(`corrupt central directory at entry ${index}`);
    }
    const method = archive.readUInt16LE(offset + 10);
    const expectedCrc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (compressedSize === ZIP64_MARKER || size === ZIP64_MARKER || localOffset === ZIP64_MARKER) {
      throw new Error(`ZIP64 entry not supported: ${name}`);
    }
    entries.push({
      name,
      compressedSize,
      size,
      read: () => readEntry(archive, { name, method, expectedCrc, compressedSize, size, localOffset }),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const lowest = Math.max(0, archive.length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE);
  for (let position = archive.length - EOCD_MIN_SIZE; position >= lowest; position--) {
    if (archive.readUInt32LE(position) === EOCD_SIGNATURE) {
      return position;
    }
  }
  throw new Error("not a zip archive (end of central directory not found)");
}

interface EntryLocation {
  name: string;
  method: number;
  expectedCrc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

function readEntry(archive: Buffer, entry: EntryLocation): Buffer {
  const local = entry.localOffset;
  if (archive.readUInt32LE(local) !== LOCAL_SIGNATURE) {
    throw new Error(`corrupt local header: ${entry.name}`);
  }
  const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
  const raw = archive.subarray(start, start + entry.compressedSize);
  let data: Buffer;
  if (entry.method === 0) {
    data = Buffer.from(raw);
  } else if (entry.method === 8) {
    data = inflateRawSync(raw);
  } else {
    throw new Error(`unsupported compression method ${entry.method}: ${entry.name}`);
  }
  if (data.length !== entry.size || crc32(data) !== entry.expectedCrc) {
    throw new Error(`size or CRC-32 mismatch: ${entry.name}`);
  }
  return data;
}
