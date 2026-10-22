import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One temporary root per test run. Tests make their scratch directories with
 * `mkdtemp(tmpdir())` and mostly leave them behind; pointing the temp-directory variables
 * at a run root before any worker starts gathers all of them, and everything the child
 * processes write, under one directory that is removed when the run ends. A run that is
 * killed leaves its root behind; the next run removes roots whose process is gone.
 */
export const RUN_ROOT_ENV = "AMBER_TEST_RUN_ROOT";
const RUN_ROOT_NAME = /^amber-test-run-(\d+)-/;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Removes the run roots in `base` whose owning process has exited. */
export function sweepStaleRunRoots(base: string): void {
  for (const name of readdirSync(base)) {
    const match = RUN_ROOT_NAME.exec(name);
    if (match !== null && !isAlive(Number(match[1]))) {
      rmSync(join(base, name), { recursive: true, force: true });
    }
  }
}

/**
 * The run root of this process tree, created on first use. Later calls, including those in
 * workers that inherited the environment, return the same directory.
 */
export function enterRunRoot(): string {
  const existing = process.env[RUN_ROOT_ENV];
  if (existing !== undefined && existing !== "") {
    return existing;
  }
  const base = tmpdir();
  sweepStaleRunRoots(base);
  const root = mkdtempSync(join(base, `amber-test-run-${process.pid}-`));
  process.env[RUN_ROOT_ENV] = root;
  // `os.tmpdir()` reads TMPDIR on POSIX and TEMP / TMP on Windows, at every call.
  for (const name of ["TMPDIR", "TEMP", "TMP"]) {
    process.env[name] = root;
  }
  return root;
}

export function removeRunRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}
