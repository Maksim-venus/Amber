// Logger implementation with redaction.
import type { LogFields, Logger } from "../../ports/logger.ts";

export const REDACTED = "[REDACTED]";

/**
 * Field names whose values never reach a log line: credentials of every kind, anything
 * named like a key, and `value`, the field that carries a secret being written.
 */
const SENSITIVE_NAME = /authorization|cookie|token|secret|password|passwd|key|sessdata|bili_jct|^value$/i;
const BEARER = /\b(Bearer|Basic)\s+[^\s,;]+/gi;
const MAX_DEPTH = 8;

/** Copies `fields`, replacing sensitive values at any depth and credentials embedded in strings. */
export function redactFields(fields: unknown, depth = 0): unknown {
  if (typeof fields === "string") {
    return redactText(fields);
  }
  if (fields === null || typeof fields !== "object" || depth >= MAX_DEPTH) {
    return fields;
  }
  if (Array.isArray(fields)) {
    return fields.map((item) => redactFields(item, depth + 1));
  }
  if (fields instanceof Error) {
    return { name: fields.name, message: redactText(fields.message) };
  }
  const copy: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    copy[name] = SENSITIVE_NAME.test(name) ? REDACTED : redactFields(value, depth + 1);
  }
  return copy;
}

/** Masks authorization schemes and sensitive query parameters inside free text and URLs. */
export function redactText(text: string): string {
  return text.replace(BEARER, `$1 ${REDACTED}`).replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (match, separator: string, name: string) =>
    SENSITIVE_NAME.test(decodeURIComponentSafe(name)) ? `${separator}${name}=${REDACTED}` : match,
  );
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The structural subset of the HTTP framework's logger that this adapter drives. */
export interface StructuredLogSink {
  debug(fields: object, message: string): void;
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
  child(bindings: object): StructuredLogSink;
}

/** Wraps the injected framework logger as the Logger port; every field set is redacted first. */
export function createLogger(sink: StructuredLogSink): Logger {
  const fieldsOf = (fields: LogFields | undefined): object => (fields === undefined ? {} : (redactFields(fields) as object));
  return {
    debug: (message, fields) => sink.debug(fieldsOf(fields), message),
    info: (message, fields) => sink.info(fieldsOf(fields), message),
    warn: (message, fields) => sink.warn(fieldsOf(fields), message),
    error: (message, fields) => sink.error(fieldsOf(fields), message),
    child: (bindings) => createLogger(sink.child(fieldsOf(bindings))),
  };
}

interface LoggedRequest {
  method: string;
  url: string;
  headers: Record<string, unknown>;
}

/**
 * Options for the HTTP framework's logger: structured JSON lines to `destination`,
 * request logs with redacted URL and headers, and path-based redaction of the usual
 * credential headers as a second line of defense.
 */
export function httpLoggerOptions(options: { level: string; destination: { write(line: string): void } }) {
  return {
    level: options.level,
    stream: options.destination,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-amber-setup-token"]',
        'req.headers["x-api-key"]',
        'res.headers["set-cookie"]',
      ],
      censor: REDACTED,
    },
    serializers: {
      req: (request: LoggedRequest) => ({
        method: request.method,
        url: redactText(request.url),
        headers: redactFields(request.headers),
      }),
      res: (reply: { statusCode: number }) => ({ statusCode: reply.statusCode }),
      err: (error: Error) => ({ type: error.name, message: redactText(error.message), stack: redactText(error.stack ?? "") }),
    },
  };
}
