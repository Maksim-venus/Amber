/** A response body larger than the reader accepts; carries no content. */
export class BodyTooLargeError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`response body exceeds ${limitBytes} bytes`);
    this.name = "BodyTooLargeError";
    this.limitBytes = limitBytes;
  }
}

/**
 * Reads a response body as UTF-8, refusing it once it passes `limitBytes`: an upstream
 * answer, however malformed, never makes the process hold more than it bargained for.
 * Reading stops at the first chunk over the limit.
 */
export async function readBounded(body: AsyncIterable<Uint8Array>, limitBytes: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > limitBytes) {
      throw new BodyTooLargeError(limitBytes);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
