import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./lib/files.ts";
import { fixtureRoot } from "./lib/fixture.ts";
import { namingAndMirror } from "./lib/naming.ts";

describe("kebab-case file names and mirrored tests", () => {
  it("finds no violation in the repository", () => {
    expect(namingAndMirror(REPO_ROOT)).toEqual([]);
  });

  it("rejects the counter-example fixture", () => {
    expect(namingAndMirror(fixtureRoot("naming"))).toEqual([
      { file: "src/server/domain/TaskRunner.ts", rule: "file-name-not-kebab-case" },
      { file: "test/server/domain/helpers.ts", rule: "test-outside-dedicated-dir-not-named-test" },
      { file: "test/server/domain/missing-source.test.ts", rule: "test-without-mirrored-source" },
    ]);
  });
});
