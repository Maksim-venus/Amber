import { createHash } from "node:crypto";
import { canonicalJson } from "../domain/canonical-json.ts";
import { amberError } from "../domain/errors.ts";
import type { RepositoryScope } from "../ports/repository.ts";

/** Visible ASCII without spaces, as sent in the `Idempotency-Key` header. */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

export function isValidIdempotencyKey(key: string): boolean {
  return IDEMPOTENCY_KEY.test(key);
}

const sha256 = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** Digest of a JSON request: sha256 over its canonical form, so key order and spacing do not matter. */
export function jsonRequestDigest(request: unknown): string {
  return sha256(canonicalJson(request));
}

/**
 * Digest of a multipart upload, computed after the upload completes and before any
 * resource is created: file parts contribute their content digests under fixed logical
 * names, never their bytes or client file names.
 */
export function multipartRequestDigest(parts: {
  mediaSha256: string;
  subtitleSha256?: string;
  metadata: Readonly<Record<string, unknown>>;
}): string {
  return sha256(canonicalJson(parts));
}

export interface IdempotencyContext {
  userId: string;
  /** Route template such as `POST /api/contents/import`. */
  route: string;
  /** Absent when the client sent no `Idempotency-Key`. */
  key: string | undefined;
  requestDigest: string;
}

export interface CreatedResponse<T> {
  status: number;
  body: T;
  /** Every resource id the request created. */
  resourceRefs: string[];
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Runs `create` under the client's `Idempotency-Key`, inside the caller's transaction. A key
 * belongs to one user and one route and is judged by the request digest: a repeated key with
 * the same digest replays the stored response without creating anything; the same key with
 * a different request is `idempotency_conflict`; without a key `create` simply runs. The
 * record commits together with what `create` wrote, so a rolled-back request leaves no
 * record behind. Records never expire. The key only stops a client from submitting the same
 * request twice; it does not replace the retry rules of paid calls.
 */
export function runIdempotent<T>(
  scope: RepositoryScope,
  context: IdempotencyContext,
  now: number,
  create: () => CreatedResponse<T>,
): IdempotentResult<T> {
  const { key } = context;
  if (key !== undefined) {
    const stored = scope.idempotency.get(context.userId, context.route, key);
    if (stored !== undefined) {
      if (stored.requestDigest !== context.requestDigest) {
        throw amberError("idempotency_conflict", "idempotency key reused with a different request");
      }
      return { status: stored.responseStatus, body: JSON.parse(stored.responseBodyJson) as T, replayed: true };
    }
  }
  const created = create();
  if (key !== undefined) {
    scope.idempotency.insert({
      userId: context.userId,
      route: context.route,
      key,
      requestDigest: context.requestDigest,
      responseStatus: created.status,
      responseBodyJson: JSON.stringify(created.body),
      resourceRefsJson: JSON.stringify(created.resourceRefs),
      createdAt: now,
    });
  }
  return { status: created.status, body: created.body, replayed: false };
}
