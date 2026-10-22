import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { RUN_ROOT_ENV, sweepStaleRunRoots } from "./temp-root.ts";

describe("test run temp root", () => {
  it("puts every scratch directory of the run under the run root", () => {
    const root = process.env[RUN_ROOT_ENV] ?? "";
    expect(basename(root)).toMatch(/^amber-test-run-\d+-/);
    const scratch = mkdtempSync(join(tmpdir(), "amber-scratch-"));
    expect(dirname(scratch)).toBe(root);
  });

  it("sweeps roots of exited runs only", () => {
    const base = mkdtempSync(join(tmpdir(), "amber-sweep-"));
    // PID 2^22 + 1 is above Linux's pid_max ceiling, so no process can hold it.
    const exited = join(base, "amber-test-run-4194305-abcdef");
    const running = join(base, `amber-test-run-${process.pid}-abcdef`);
    const unrelated = join(base, "amber-pipeline-abcdef");
    for (const dir of [exited, running, unrelated]) mkdirSync(dir);
    sweepStaleRunRoots(base);
    expect([exited, running, unrelated].map((dir) => existsSync(dir))).toEqual([false, true, true]);
  });
});
