/**
 * Where to return after logging in. Held in memory only, never in the URL, and only a
 * same-origin relative path is accepted, so a crafted link cannot send the user elsewhere
 * after login.
 */
const DEFAULT_NEXT = "/library";
const AUTH_PAGES = ["/login", "/setup"];

let remembered: string | undefined;

/** A same-origin relative path (`/x`, not `//host` or `/\host`) outside the auth pages, else undefined. */
export function safeNextPath(path: string): string | undefined {
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return undefined;
  const pathname = path.split(/[?#]/)[0] ?? "";
  if (AUTH_PAGES.some((page) => pathname === page || pathname.startsWith(`${page}/`))) return undefined;
  return path;
}

export function rememberNext(path: string): void {
  const safe = safeNextPath(path);
  if (safe !== undefined) remembered = safe;
}

/** The remembered path, or the library; safe to call during render. */
export function peekNext(): string {
  return remembered ?? DEFAULT_NEXT;
}

/** The remembered path (consumed), or the library; for event handlers. */
export function takeNext(): string {
  const next = peekNext();
  remembered = undefined;
  return next;
}

/** Drops the remembered path (logout: the next login starts fresh). */
export function forgetNext(): void {
  remembered = undefined;
}

/** Whether `pathname` is one of the pages reachable without a session. */
export function isAuthPage(pathname: string): boolean {
  return AUTH_PAGES.some((page) => pathname === page || pathname.startsWith(`${page}/`));
}
