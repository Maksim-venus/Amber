import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./lib/files.ts";
import { fixtureRoot } from "./lib/fixture.ts";
import { toolingImports } from "./lib/layer-imports.ts";

describe("src/tooling depends only on built-ins, approved tooling packages and pure shared data", () => {
  it("finds no violation in the repository", () => {
    expect(toolingImports(REPO_ROOT)).toEqual([]);
  });

  it("rejects the counter-example fixture", () => {
    expect(toolingImports(fixtureRoot("tooling-imports"))).toEqual([
      { file: "src/tooling/build-server.ts", rule: "tooling-imports-package", line: 2 },
      { file: "src/tooling/build-server.ts", rule: "tooling-imports-layer", line: 3 },
      { file: "src/tooling/build-server.ts", rule: "tooling-imports-impure-shared", line: 4 },
    ]);
  });
});
