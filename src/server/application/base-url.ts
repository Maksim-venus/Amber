import { amberError } from "../domain/errors.ts";

/**
 * A provider endpoint as stored: a plain http(s) URL without credentials, query or
 * fragment, trimmed and without trailing slashes, so adapters append their protocol path.
 * Anything else is `invalid_request`.
 */
export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw amberError("invalid_request", "baseURL is not a URL", { params: { detail: "baseURL" } });
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw amberError("invalid_request", "baseURL must be a plain http(s) URL", { params: { detail: "baseURL" } });
  }
  return trimmed.replace(/\/+$/u, "");
}
