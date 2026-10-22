import { chmodSync, lstatSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CACHE_ROOT_MARKER,
  CACHE_ROOT_MARKER_MAGIC,
  CACHE_ROOTS_FILE,
  DATA_ROOT_MARKER,
  DATA_ROOT_MARKER_MAGIC,
  isMarkerText,
} from "../shared/app-identity.ts";

/**
 * The desktop uninstaller's data remover, run by the uninstall hook as
 * `node uninstall-data.js <dataDir> [reportPath]` after the user confirmed "delete all data".
 *
 * It removes every relocated cache directory listed in `<dataDir>/cache-roots.txt`, then the
 * data directory itself, each only when it is a real directory (not a symbolic link or
 * junction) carrying Amber's ownership marker. Inside a root, an entry `lstat` reports as a
 * symbolic link is unlinked and never descended into: Node reports Windows junctions as
 * symbolic links, whereas NSIS `RMDir /r` would follow them and delete what they point to.
 *
 * The outcome goes to a UTF-16LE report, one `<STATUS> <path>` line per root, which the
 * hook reads with `FileReadUTF16LE`. Only Node built-ins and `src/shared/app-identity.ts`
 * are used, so the bundle runs with nothing but the shipped `node.exe`.
 */

export const UNINSTALL_REPORT_FILE = "amber-uninstall-report.txt";

/**
 * `OK`: the root is gone. `LEFT`: something in it could not be removed (its marker stays,
 * so a later run may finish the job). `MISSING`: the root does not exist, e.g. its drive is
 * disconnected. `REFUSED`: a link, not a directory, or without a valid marker; untouched.
 */
export type RootStatus = "OK" | "LEFT" | "MISSING" | "REFUSED";

export interface RootOutcome {
  status: RootStatus;
  path: string;
}

export interface UninstallResult {
  outcomes: RootOutcome[];
  /** 0 when every listed root is gone, 2 otherwise. */
  exitCode: 0 | 2;
}

/** The registry's paths: UTF-16LE with an optional byte order mark, one path per line. */
export function parseCacheRoots(bytes: Buffer): string[] {
  let text = bytes.toString("utf16le");
  if (text.startsWith("\uFEFF")) {
    text = text.slice(1);
  }
  const roots: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const path = line.replace(/\r$/u, "");
    if (path !== "" && !roots.includes(path)) {
      roots.push(path);
    }
  }
  return roots;
}

/** The report the hook reads: UTF-16LE with a byte order mark, CRLF line ends. */
export function renderReport(outcomes: readonly RootOutcome[]): Buffer {
  const text = outcomes.map(({ status, path }) => `${status} ${path}\r\n`).join("");
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** Removes a symbolic link or junction itself; `rmdir` covers directory links `unlink` refuses. */
function removeLink(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return;
    }
    rmdirSync(path);
  }
}

/** Removes a file; a read-only one gets write permission first. */
function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      return;
    }
    if (code !== "EPERM" && code !== "EACCES") {
      throw error;
    }
    chmodSync(path, 0o666);
    unlinkSync(path);
  }
}

/**
 * Deletes everything below `dir` except the names in `keep`, top-down, and reports whether
 * all of it is gone. Failures do not stop the walk: as much as possible goes.
 */
function emptyDirectory(dir: string, keep: ReadonlySet<string> = new Set()): boolean {
  let complete = true;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (keep.has(name)) {
      continue;
    }
    const path = join(dir, name);
    try {
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        removeLink(path);
      } else if (stats.isDirectory()) {
        if (emptyDirectory(path)) {
          rmdirSync(path);
        } else {
          complete = false;
        }
      } else {
        removeFile(path);
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        complete = false;
      }
    }
  }
  return complete;
}

/** Whether `path` is a regular file holding a valid marker with `magic`. */
function hasMarker(path: string, magic: string): boolean {
  try {
    if (!lstatSync(path).isFile()) {
      return false;
    }
    return isMarkerText(readFileSync(path, "utf8"), magic);
  } catch {
    return false;
  }
}

/**
 * Removes one owned root: refused unless it is a real directory with a valid marker; the
 * marker goes last so that an interrupted or partial removal stays recognizable.
 */
export function removeOwnedRoot(root: string, marker: string, magic: string): RootStatus {
  if (!isAbsolute(root)) {
    return "REFUSED";
  }
  let stats;
  try {
    stats = lstatSync(root);
  } catch (error) {
    return errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR" ? "MISSING" : "LEFT";
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return "REFUSED";
  }
  const markerPath = join(root, marker);
  if (!hasMarker(markerPath, magic)) {
    return "REFUSED";
  }
  if (!emptyDirectory(root, new Set([marker]))) {
    return "LEFT";
  }
  try {
    removeFile(markerPath);
    rmdirSync(root);
  } catch {
    return "LEFT";
  }
  return "OK";
}

/**
 * Removes a state directory Amber knows by its fixed path but never marked: the WebView2 state
 * of builds under the legacy identifier. A link is refused and nothing is
 * removed through one.
 */
export function removeStateDir(dir: string): RootStatus {
  if (!isAbsolute(dir)) {
    return "REFUSED";
  }
  let stats;
  try {
    stats = lstatSync(dir);
  } catch (error) {
    return errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR" ? "MISSING" : "LEFT";
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return "REFUSED";
  }
  if (!emptyDirectory(dir)) {
    return "LEFT";
  }
  try {
    rmdirSync(dir);
  } catch {
    return "LEFT";
  }
  return "OK";
}

/** The custom cache roots registered in the data directory, or `undefined` when unreadable. */
function registeredCacheRoots(dataDir: string): string[] | undefined {
  const registry = join(dataDir, CACHE_ROOTS_FILE);
  try {
    if (!lstatSync(registry).isFile()) {
      return undefined;
    }
    return parseCacheRoots(readFileSync(registry));
  } catch (error) {
    return errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR" ? [] : undefined;
  }
}

/**
 * Removes the registered cache roots and then the data directory. When the registry exists
 * but cannot be read, the data directory is kept: deleting it would lose the only record
 * of cache directories elsewhere on disk. A `legacyStateDir` goes first, so the data
 * directory's line stays the last one, and is not reported when it does not exist.
 */
export function uninstallData(dataDir: string, legacyStateDir?: string): UninstallResult {
  const outcomes: RootOutcome[] = [];
  if (legacyStateDir !== undefined && legacyStateDir !== "") {
    const legacyStatus = removeStateDir(legacyStateDir);
    if (legacyStatus !== "MISSING") {
      outcomes.push({ status: legacyStatus, path: legacyStateDir });
    }
  }
  const roots = registeredCacheRoots(dataDir);
  for (const root of roots ?? []) {
    outcomes.push({ status: removeOwnedRoot(root, CACHE_ROOT_MARKER, CACHE_ROOT_MARKER_MAGIC), path: root });
  }
  const dataStatus = roots === undefined ? "LEFT" : removeOwnedRoot(dataDir, DATA_ROOT_MARKER, DATA_ROOT_MARKER_MAGIC);
  outcomes.push({ status: dataStatus, path: dataDir });
  return { outcomes, exitCode: outcomes.every(({ status }) => status === "OK") ? 0 : 2 };
}

function main(): void {
  const [dataDir, reportPath = join(tmpdir(), UNINSTALL_REPORT_FILE), legacyStateDir] = process.argv.slice(2);
  if (dataDir === undefined || dataDir === "") {
    console.error("usage: node uninstall-data.js <dataDir> [reportPath] [legacyStateDir]");
    process.exitCode = 2;
    return;
  }
  const result = uninstallData(dataDir, legacyStateDir);
  writeFileSync(reportPath, renderReport(result.outcomes));
  process.exitCode = result.exitCode;
}

/**
 * Whether this module is the script Node was started with. Both sides are real paths, compared
 * without case on Windows: the hook passes `$INSTDIR`, whose spelling may differ from the one
 * Node resolves, and a mismatch would silently skip the removal.
 */
function isEntryScript(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    const [a, b] = [realpathSync(resolve(entry)), realpathSync(fileURLToPath(import.meta.url))];
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isEntryScript()) {
  try {
    main();
  } catch (error) {
    console.error(`uninstall-data: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
