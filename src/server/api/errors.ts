import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppError, ErrorClass } from "../../shared/errors.ts";
import { appError, isAmberError } from "../domain/errors.ts";
import type { Logger } from "../ports/logger.ts";

/** HTTP status per error class; unlisted business classes are 422. */
const HTTP_STATUS: Partial<Record<ErrorClass, number>> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  conflict: 409,
  idempotency_conflict: 409,
  rate_limited: 429,
  media_too_large: 413,
  disk_low: 507,
  storage_quota_exceeded: 507,
  internal: 500,
};
const BUSINESS_STATUS = 422;

/** Refined codes whose status differs from their class. */
const HTTP_STATUS_BY_CODE: Readonly<Record<string, number>> = {
  "invalid_request.range_not_satisfiable": 416,
};

export function httpStatusOf(error: AppError): number {
  return HTTP_STATUS_BY_CODE[error.code] ?? HTTP_STATUS[error.class] ?? BUSINESS_STATUS;
}

/**
 * Every failure leaves as `{ error: AppError }`: AmberErrors map by
 * class, request errors raised by the framework itself (malformed JSON, unsupported
 * content type, oversized body) become `invalid_request`, unmatched routes `not_found`
 * (unless the optional fallback answers them, as the SPA host does outside `/api`), and
 * anything else `internal`, logged but never echoed.
 */
export function installErrorHandling(
  app: FastifyInstance,
  logger: Logger,
  options: { notFoundFallback?: (request: FastifyRequest, reply: FastifyReply) => FastifyReply | undefined } = {},
): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (isAmberError(error)) {
      const status = httpStatusOf(error.appError);
      if (status >= 500) {
        logger.error("request_failed", { route: request.routeOptions.url, code: error.appError.code, error: error.message });
      }
      return reply.code(status).send({ error: error.appError });
    }
    if (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(400).send({ error: appError("invalid_request", { params: { detail: "body" } }) });
    }
    logger.error("request_failed_unexpectedly", { route: request.routeOptions.url, error });
    return reply.code(500).send({ error: appError("internal") });
  });
  app.setNotFoundHandler((request, reply) => options.notFoundFallback?.(request, reply) ?? reply.code(404).send({ error: appError("not_found") }));
}
