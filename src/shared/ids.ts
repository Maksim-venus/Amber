import { z } from "zod";

declare const brand: unique symbol;

/**
 * Nominal typing helper: a `T` that only values produced by a trusted constructor may carry.
 * Brands are keys rather than a single literal so they compose: a `SegmentId` is still a
 * `Ulid`, instead of the two literals intersecting to `never`.
 */
export type Brand<T, B extends string> = T & { readonly [brand]: { readonly [K in B]: true } };

/** Crockford base32 ULID, 26 characters. */
export type Ulid = Brand<string, "Ulid">;

/**
 * Identity of a TranscriptSegment. Globally unique so that `[[seg:<segmentId>]]`
 * markers and `?segment=` deep links resolve without any other context.
 */
export type SegmentId = Brand<Ulid, "SegmentId">;

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function isUlid(value: string): value is Ulid {
  return ULID_PATTERN.test(value);
}

export const ulidSchema = z.string().regex(ULID_PATTERN).transform((value) => value as Ulid);

export const segmentIdSchema = ulidSchema.transform((value) => value as SegmentId);
