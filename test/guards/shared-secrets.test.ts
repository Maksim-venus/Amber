import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./lib/files.ts";
import { fixtureRoot } from "./lib/fixture.ts";
import { sharedSecrets } from "./lib/shared-secrets.ts";

describe("src/shared declares no secret-bearing fields or types", () => {
  it("finds no violation in the repository", () => {
    expect(sharedSecrets(REPO_ROOT)).toEqual([]);
  });

  it("rejects the counter-example fixture", () => {
    expect(sharedSecrets(fixtureRoot("shared-secrets"))).toEqual([
      { file: "src/shared/dto/provider.ts", rule: "shared-secret-field", line: 5 },
      { file: "src/shared/dto/provider.ts", rule: "shared-secret-type", line: 8 },
      { file: "src/shared/dto/provider.ts", rule: "shared-secret-field", line: 10 },
    ]);
  });
});
