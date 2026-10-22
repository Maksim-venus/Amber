import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./lib/files.ts";
import { fixtureRoot } from "./lib/fixture.ts";
import { webImportsServer } from "./lib/layer-imports.ts";

describe("src/web does not import src/server", () => {
  it("finds no violation in the repository", () => {
    expect(webImportsServer(REPO_ROOT)).toEqual([]);
  });

  it("rejects the counter-example fixture", () => {
    expect(webImportsServer(fixtureRoot("web-imports-server"))).toEqual([{ file: "src/web/page.ts", rule: "web-imports-server", line: 1 }]);
  });
});
