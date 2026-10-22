export type LogFields = Readonly<Record<string, unknown>>;

/**
 * Structured logging. Messages are English or stable codes. By default nothing logs
 * transcript text, prompts, chat bodies, raw provider requests or any secret; debug
 * detail must be enabled explicitly.
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}
