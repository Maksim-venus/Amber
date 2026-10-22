import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./lib/files.ts";
import { fixtureRoot } from "./lib/fixture.ts";
import { platformLiterals } from "./lib/platform-literals.ts";

describe("application / pipeline do not branch on platform literals", () => {
  it("finds no violation in the repository", () => {
    expect(platformLiterals(REPO_ROOT)).toEqual([]);
  });

  it("rejects the counter-example fixture", () => {
    expect(platformLiterals(fixtureRoot("platform-literals"))).toEqual([{ file: "src/server/pipeline/source-stage.ts", rule: "platform-literal", line: 2 }]);
  });
});
