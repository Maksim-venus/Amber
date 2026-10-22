import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./lib/files.ts";
import { fixtureRoot } from "./lib/fixture.ts";
import { defaultsSingleSource } from "./lib/defaults-source.ts";

describe("named defaults are defined only in src/shared/defaults.ts", () => {
  it("finds no violation in the repository", () => {
    expect(defaultsSingleSource(REPO_ROOT)).toEqual([]);
  });

  it("rejects the counter-example fixture", () => {
    expect(defaultsSingleSource(fixtureRoot("defaults-source"))).toEqual([
      { file: "src/server/pipeline/retry.ts", rule: "default-redefined", line: 1 },
      { file: "src/server/pipeline/retry.ts", rule: "default-redefined", line: 4 },
    ]);
  });
});
