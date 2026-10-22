import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";

/** One multipart part; `data` may be a generator so large bodies are never held in memory. */
export interface FormPart {
  name: string;
  filename?: string;
  data: Buffer | string | (() => AsyncIterable<Buffer>);
}

/** A streaming `multipart/form-data` body in the given part order, as a browser would send it. */
export function multipartBody(parts: readonly FormPart[]): { contentType: string; stream: () => Readable } {
  const boundary = `----amber${randomBytes(12).toString("hex")}`;
  async function* generate(): AsyncIterable<Buffer> {
    for (const part of parts) {
      const disposition = `form-data; name="${part.name}"${part.filename === undefined ? "" : `; filename="${part.filename}"`}`;
      const type = part.filename === undefined ? "" : "Content-Type: application/octet-stream\r\n";
      yield Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n${type}\r\n`);
      if (typeof part.data === "function") {
        yield* part.data();
      } else {
        yield Buffer.from(part.data);
      }
      yield Buffer.from("\r\n");
    }
    yield Buffer.from(`--${boundary}--\r\n`);
  }
  return { contentType: `multipart/form-data; boundary=${boundary}`, stream: () => Readable.from(generate(), { objectMode: false }) };
}

/**
 * `size` bytes of a valid MP4: the fixture followed by one top-level `free` box of zeros,
 * which demuxers skip. Streams a shared zero chunk, so the generator allocates nothing per call.
 */
export function paddedMp4(fixture: Buffer, size: number, chunkBytes = 1024 * 1024): () => AsyncIterable<Buffer> {
  const padding = size - fixture.length;
  if (padding < 8 || padding > 0xffffffff) {
    throw new RangeError("padding must fit one 32-bit free box");
  }
  const zeros = Buffer.alloc(chunkBytes);
  return async function* () {
    yield fixture;
    const header = Buffer.alloc(8);
    header.writeUInt32BE(padding, 0);
    header.write("free", 4, "latin1");
    yield header;
    for (let remaining = padding - 8; remaining > 0; remaining -= chunkBytes) {
      yield remaining >= chunkBytes ? zeros : zeros.subarray(0, remaining);
    }
  };
}

/** `size` bytes of zeros from one shared chunk. */
export function zeroStream(size: number, chunkBytes = 4 * 1024 * 1024): () => AsyncIterable<Buffer> {
  const zeros = Buffer.alloc(chunkBytes);
  return async function* () {
    for (let remaining = size; remaining > 0; remaining -= chunkBytes) {
      yield remaining >= chunkBytes ? zeros : zeros.subarray(0, remaining);
    }
  };
}
