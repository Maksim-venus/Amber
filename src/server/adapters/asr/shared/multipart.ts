import { randomBytes } from "node:crypto";
import type { OutboundStreamBody } from "../../../ports/outbound-http.ts";

const CRLF = "\r\n";

export interface MultipartFile {
  name: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  stream: AsyncIterable<Uint8Array>;
}

/**
 * `multipart/form-data` written as a stream: text fields first, then the file part read
 * from disk chunk by chunk, so an hours-long recording never sits in memory.
 * A field given several values is repeated once per value. The length is computed up
 * front from the file size; a file that yields a different number of bytes fails the
 * upload rather than sending a body that disagrees with its `Content-Length`.
 */
export function multipartStream(fields: ReadonlyArray<readonly [string, string]>, file: MultipartFile): OutboundStreamBody {
  const boundary = `----amber-${randomBytes(16).toString("hex")}`;
  const head = Buffer.from(
    fields.map(([name, value]) => `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${fieldValue(value)}${CRLF}`).join("") +
      `--${boundary}${CRLF}Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"${CRLF}` +
      `Content-Type: ${file.contentType}${CRLF}${CRLF}`,
    "utf8",
  );
  const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, "utf8");
  async function* stream(): AsyncIterable<Uint8Array> {
    yield head;
    let sent = 0;
    for await (const chunk of file.stream) {
      sent += chunk.byteLength;
      if (sent > file.sizeBytes) {
        throw new Error("audio file is larger than recorded");
      }
      yield chunk;
    }
    if (sent !== file.sizeBytes) {
      throw new Error("audio file is smaller than recorded");
    }
    yield tail;
  }
  return {
    stream: stream(),
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength: head.byteLength + file.sizeBytes + tail.byteLength,
  };
}

/** Line breaks would end the part early; terms and codes never need them. */
function fieldValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}
