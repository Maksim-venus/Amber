import {
  allowedDetailsKeys,
  ERROR_CLASS_DEFAULTS,
  isErrorClassUsableAsError,
  REFINED_ERROR_CODE_REGISTRY,
  type AppError,
  type AppErrorDetails,
  type ErrorClass,
  type RefinedErrorCode,
  type RefinedErrorCodeSpec,
} from "../../shared/errors.ts";
import { errors as zhCnErrors, refinedErrors as zhCnRefinedErrors } from "../../shared/i18n/zh-CN/errors.ts";

export interface AppErrorOptions {
  /** A registered refined code; must start with `<class>.`. */
  code?: RefinedErrorCode;
  /** Values for `{{name}}` placeholders in the user message. */
  params?: Readonly<Record<string, string>>;
  /** Redacted upstream text; never contains credentials. */
  upstreamMessage?: string;
  /** Structured details under the keys registered for `code` in the error catalogue. */
  details?: AppErrorDetails;
}

/**
 * Builds an AppError with the defaults of its error class and the user message from
 * the i18n resources. A refined code may override the class disposition / action and
 * bring its own message; its `details` keys must be registered. Status-only classes
 * (default disposition "—") are rejected: they belong in `StageRun.resultJson.reasons[]`,
 * never in an error.
 */
export function appError(errorClass: ErrorClass, options: AppErrorOptions = {}): AppError {
  const defaults = ERROR_CLASS_DEFAULTS[errorClass];
  if (!isErrorClassUsableAsError(errorClass) || defaults.retryDisposition === null) {
    throw new TypeError(`${errorClass} is a status code and cannot be raised as an error`);
  }
  if (options.code !== undefined && !options.code.startsWith(`${errorClass}.`)) {
    throw new TypeError(`${options.code} is not a refinement of ${errorClass}`);
  }
  const code = options.code ?? errorClass;
  const spec: RefinedErrorCodeSpec = options.code === undefined ? {} : REFINED_ERROR_CODE_REGISTRY[options.code];
  if (options.details !== undefined) {
    const allowed = allowedDetailsKeys(code);
    const stray = Object.keys(options.details).filter((key) => !allowed.includes(key));
    if (stray.length > 0) {
      throw new TypeError(`${code} does not register details ${stray.join(", ")}`);
    }
  }
  const template = (options.code === undefined ? undefined : zhCnRefinedErrors[options.code]) ?? zhCnErrors[errorClass];
  const userMessage = template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => options.params?.[name] ?? "");
  const action = spec.action ?? defaults.action;
  return {
    class: errorClass,
    code,
    retryDisposition: spec.retryDisposition ?? defaults.retryDisposition,
    userMessage,
    ...(options.upstreamMessage === undefined ? {} : { upstreamMessage: options.upstreamMessage }),
    ...(action === undefined ? {} : { action }),
    ...(options.details === undefined ? {} : { details: options.details }),
  };
}

/**
 * The throwable carrier of an AppError inside the server. `message` is for internal logs
 * only and, like the AppError itself, must never contain secret material.
 */
export class AmberError extends Error {
  readonly appError: AppError;

  constructor(error: AppError, internalMessage?: string, options?: { cause?: unknown }) {
    super(internalMessage ?? error.code, options);
    this.name = "AmberError";
    this.appError = error;
  }
}

/** Shorthand for `new AmberError(appError(...))`. */
export function amberError(errorClass: ErrorClass, internalMessage?: string, options: AppErrorOptions = {}): AmberError {
  return new AmberError(appError(errorClass, options), internalMessage);
}

export function isAmberError(value: unknown): value is AmberError {
  return value instanceof AmberError;
}

/** `Bearer <token>` as sent in an Authorization header and echoed back by some relays. */
const BEARER_TOKEN = /\bBearer\s+[^\s"',;]+/gi;
/** OpenAI-style and Anthropic keys (`sk-...`, `sk-proj-...`, `sk-ant-...`). */
const SK_KEY = /\bsk-[A-Za-z0-9_-]{8,}/g;
/** A query string of `name=value` pairs, absolute URL or path alike; keys may ride in it. */
const QUERY_STRING = /\?[\w.%[\]-]+=[^\s#"'<>]*/g;

/**
 * Removes what an upstream error text may echo of credentials or request data before it
 * goes into `AppError.upstreamMessage`. Invariant: secrets never reach error messages.
 * Removed are bearer tokens, `sk-` keys and query-string values, which may carry keys or
 * signed parameters. Whitespace is
 * collapsed so a multi-line page reads as one line.
 */
export function sanitizeUpstreamText(text: string): string {
  return text
    .replace(BEARER_TOKEN, "Bearer ***")
    .replace(SK_KEY, "sk-***")
    .replace(QUERY_STRING, (query) =>
      `?${query
        .slice(1)
        .split("&")
        .map((pair) => {
          const equals = pair.indexOf("=");
          return equals === -1 ? pair : `${pair.slice(0, equals)}=***`;
        })
        .join("&")}`,
    )
    .replace(/\s+/g, " ")
    .trim();
}
