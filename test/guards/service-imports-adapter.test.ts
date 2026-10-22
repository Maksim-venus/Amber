import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./lib/files.ts";
import { fixtureRoot } from "./lib/fixture.ts";
import { serviceImportsAdapters } from "./lib/layer-imports.ts";

describe("application / domain / pipeline import ports, not adapters", () => {
  it("finds no violation in the repository", () => {
    expect(serviceImportsAdapters(REPO_ROOT)).toEqual([]);
  });

  it("rejects the counter-example fixture", () => {
    expect(serviceImportsAdapters(fixtureRoot("service-imports-adapter"))).toEqual([
      { file: "src/server/application/summarize.ts", rule: "service-imports-adapter", line: 1 },
      { file: "src/server/pipeline/proofread-stage.ts", rule: "service-imports-adapter", line: 2 },
    ]);
  });
});
