import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./lib/files.ts";
import { fixtureRoot } from "./lib/fixture.ts";
import { desktopBusinessLogic } from "./lib/layer-imports.ts";

describe("src/desktop holds no business logic", () => {
  it("finds no violation in the repository", () => {
    expect(desktopBusinessLogic(REPO_ROOT)).toEqual([]);
  });

  it("rejects the counter-example fixture", () => {
    expect(desktopBusinessLogic(fixtureRoot("desktop-business-logic"))).toEqual([
      { file: "src/desktop/bridge.ts", rule: "desktop-imports-server", line: 1 },
      { file: "src/desktop/Cargo.toml", rule: "desktop-http-server", line: 7 },
      { file: "src/desktop/src/main.rs", rule: "desktop-http-server", line: 1 },
    ]);
  });
});
