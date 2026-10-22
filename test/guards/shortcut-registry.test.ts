import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./lib/files.ts";
import { fixtureRoot } from "./lib/fixture.ts";
import { shortcutRegistryOnly } from "./lib/naming.ts";

describe("modifier shortcuts only through ShortcutRegistry", () => {
  it("finds no violation in the repository", () => {
    expect(shortcutRegistryOnly(REPO_ROOT)).toEqual([]);
  });

  it("rejects the counter-example fixture", () => {
    expect(shortcutRegistryOnly(fixtureRoot("shortcut-registry"))).toEqual([
      { file: "src/web/omnibox.ts", rule: "modifier-shortcut-outside-registry", line: 3 },
      { file: "src/web/omnibox.ts", rule: "modifier-shortcut-outside-registry", line: 10 },
    ]);
  });
});
