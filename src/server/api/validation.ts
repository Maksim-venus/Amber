import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { amberError } from "../domain/errors.ts";
import { isValidIdempotencyKey } from "../application/idempotency.ts";

/**
 * Runtime validation at the API boundary. The error names only the
 * offending field paths, never the submitted values.
 */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown, location: string): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const paths = [...new Set(parsed.error.issues.map((issue) => [location, ...issue.path.map(String)].join(".")))];
    throw amberError("invalid_request", `invalid ${location}`, { params: { detail: paths.join(", ") } });
  }
  return parsed.data;
}

/** Responses are validated too, so a DTO can never carry more than its schema allows. */
export function sendValidated<T extends z.ZodType>(reply: FastifyReply, status: number, schema: T, body: z.input<T>): FastifyReply {
  return reply.code(status).send(schema.parse(body));
}

/** Optional `Idempotency-Key` header; a malformed key is rejected, not ignored. */
export function idempotencyKeyOf(request: FastifyRequest): string | undefined {
  const header = request.headers["idempotency-key"];
  if (header === undefined) {
    return undefined;
  }
  if (typeof header !== "string" || !isValidIdempotencyKey(header)) {
    throw amberError("invalid_request", "malformed Idempotency-Key", { params: { detail: "Idempotency-Key" } });
  }
  return header;
}
