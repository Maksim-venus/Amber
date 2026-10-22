import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./lib/files.ts";
import { fixtureRoot } from "./lib/fixture.ts";
import { vendorConfinement } from "./lib/vendor-confinement.ts";

describe("vendor types stay inside their adapter", () => {
  it("finds no violation in the repository", () => {
    expect(vendorConfinement(REPO_ROOT)).toEqual([]);
  });

  it("rejects the counter-example fixture", () => {
    expect(vendorConfinement(fixtureRoot("vendor-confinement"))).toEqual([
      { file: "src/server/adapters/llm/fake/index.ts", rule: "adapter-imports-other-adapter", line: 2 },
      { file: "src/server/adapters/llm/fake/index.ts", rule: "adapter-reexports-vendor", line: 4 },
      { file: "src/server/adapters/llm/fake/index.ts", rule: "adapter-exports-vendor-type", line: 6 },
      { file: "src/server/api/routes.ts", rule: "adapter-imported-outside-composition-root", line: 1 },
      { file: "src/server/application/generate-summary.ts", rule: "service-imports-vendor-package", line: 1 },
    ]);
  });
});
