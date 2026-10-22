import { amberError, type AmberError } from "../../../domain/errors.ts";

/**
 * Maps a row whose absent values are SQL NULL onto a domain object whose absent values
 * are missing keys (`exactOptionalPropertyTypes`). Only keys whose value is `null` are
 * dropped; callers pass the fields already shaped for the domain type.
 */
export function withoutNulls<T>(fields: { [K in keyof T]: T[K] | null }): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}

/** Domain optional → SQL NULL. */
export function nullable<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

export function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

export function parseJsonOrNull<T>(text: string | null): T | null {
  return text === null ? null : (JSON.parse(text) as T);
}

/** An id owned by another user is reported exactly like an unknown id. */
export function notFound(kind: string, id: string): AmberError {
  return amberError("not_found", `${kind} ${id} not found for this owner`);
}
