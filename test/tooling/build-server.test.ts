import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { productionDependencies, SERVER_BUNDLE, UNINSTALL_DATA_BUNDLE } from "../../src/tooling/build-server.ts";

describe("productionDependencies", () => {
  it("externalizes exactly the production dependencies, never devDependencies", () => {
    expect(
      productionDependencies({ dependencies: { zod: "1", "better-sqlite3": "2" }, devDependencies: { vite: "3" } } as {
        dependencies: Record<string, string>;
      }),
    ).toEqual(["better-sqlite3", "zod"]);
    expect(productionDependencies({})).toEqual([]);
  });
});

describe("bundles", () => {
  it("puts the uninstaller's data remover beside the server, where the installed hook runs it", () => {
    expect(dirname(UNINSTALL_DATA_BUNDLE)).toBe(dirname(SERVER_BUNDLE));
    expect(UNINSTALL_DATA_BUNDLE.endsWith("/uninstall-data.js")).toBe(true);
  });
});
