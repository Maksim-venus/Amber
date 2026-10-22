import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./lib/files.ts";
import { fixtureRoot } from "./lib/fixture.ts";
import { modelNameBranching } from "./lib/model-branching.ts";

describe("no branching on model names", () => {
  it("finds no violation in the repository", () => {
    expect(modelNameBranching(REPO_ROOT)).toEqual([]);
  });

  it("rejects the counter-example fixture", () => {
    expect(modelNameBranching(fixtureRoot("model-branching"))).toEqual([
      { file: "src/server/pipeline/pick-strategy.ts", rule: "model-name-match", line: 2 },
      { file: "src/server/pipeline/pick-strategy.ts", rule: "model-name-comparison", line: 5 },
      { file: "src/server/pipeline/pick-strategy.ts", rule: "model-name-switch", line: 9 },
      { file: "src/server/pipeline/pick-strategy.ts", rule: "model-name-match", line: 12 },
    ]);
  });
});
