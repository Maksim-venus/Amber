import { describe, expect, it } from "vitest";
import { ciWorkflowViolations, workflowFiles } from "./lib/ci-workflow.ts";
import { REPO_ROOT } from "./lib/files.ts";
import { fixtureRoot } from "./lib/fixture.ts";

describe("CI workflows test only: no release, signing, secrets or deployment environments", () => {
  it("finds no violation in the repository, and the repository has only ci.yml", () => {
    expect(workflowFiles(REPO_ROOT)).toEqual([".github/workflows/ci.yml"]);
    expect(ciWorkflowViolations(REPO_ROOT)).toEqual([]);
  });

  it("rejects the counter-example fixtures", () => {
    expect(ciWorkflowViolations(fixtureRoot("ci-workflow"))).toEqual([
      { file: ".github/workflows/allowed.yml", rule: "ci-release-command", line: 17 },
      { file: ".github/workflows/release.yaml", rule: "ci-contents-write", line: 4 },
      { file: ".github/workflows/release.yaml", rule: "ci-environment", line: 8 },
      { file: ".github/workflows/release.yaml", rule: "ci-release-action", line: 11 },
      { file: ".github/workflows/release.yaml", rule: "ci-secret", line: 13 },
      { file: ".github/workflows/release.yaml", rule: "ci-release-command", line: 14 },
      { file: ".github/workflows/release.yaml", rule: "ci-release-command", line: 18 },
      { file: ".github/workflows/release.yaml", rule: "ci-secret", line: 21 },
      { file: ".github/workflows/release.yaml", rule: "ci-release-command", line: 22 },
      { file: ".github/workflows/release.yaml", rule: "ci-contents-write", line: 24 },
      { file: ".github/workflows/release.yaml", rule: "ci-release-command", line: 26 },
    ]);
  });
});
