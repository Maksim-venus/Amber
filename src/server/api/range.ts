/** Outcome of an HTTP `Range` header against a file of known size (RFC 9110 §14). */
export type RangeDecision =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" };

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * Only a single byte range is honored. Several ranges or a malformed header are ignored
 * and the whole file is sent, which RFC 9110 §14.2 allows; a single range that starts at
 * or beyond the end is unsatisfiable (416).
 */
export function decideRange(header: string | undefined, sizeBytes: number): RangeDecision {
  if (header === undefined) {
    return { kind: "full" };
  }
  const match = SINGLE_RANGE.exec(header.trim());
  if (match === null) {
    return { kind: "full" };
  }
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") {
    return { kind: "full" };
  }
  if (first === "") {
    // Suffix range: the last N bytes.
    const length = Number(last);
    if (length === 0 || sizeBytes === 0) {
      return { kind: "unsatisfiable" };
    }
    return { kind: "partial", start: Math.max(0, sizeBytes - length), end: sizeBytes - 1 };
  }
  const start = Number(first);
  const end = last === "" ? sizeBytes - 1 : Number(last);
  if (last !== "" && end < start) {
    return { kind: "full" };
  }
  if (start >= sizeBytes) {
    return { kind: "unsatisfiable" };
  }
  return { kind: "partial", start, end: Math.min(end, sizeBytes - 1) };
}
