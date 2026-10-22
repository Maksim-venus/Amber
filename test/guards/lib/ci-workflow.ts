import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, isPair, isScalar, isSeq, LineCounter, parseDocument, type Node } from "yaml";
import { listFiles, type Violation } from "./files.ts";

/**
 * CI-workflow guard: CI only tests, with no release, signing, secrets or deployment
 * environments. Workflow files are parsed, not grepped, so a step written as a block scalar,
 * a flow mapping or behind an anchor is checked like any other.
 */

/** Actions whose purpose is creating or uploading releases, or building and signing Tauri apps. */
const RELEASE_ACTIONS = [
  "softprops/action-gh-release",
  "ncipollo/release-action",
  "tauri-apps/tauri-action",
  "actions/create-release",
  "actions/upload-release-asset",
  "svenstaro/upload-release-action",
  "marvinpinto/action-automatic-releases",
  "googleapis/release-please-action",
  "google-github-actions/release-please-action",
] as const;

const RELEASE_COMMANDS: readonly RegExp[] = [
  /\bgh\s+release\s+(?:create|upload|edit)\b/iu,
  /\btauri(?:\.cmd)?\s+build\b/iu,
  /\btauri(?:\.cmd)?\s+signer\b/iu,
  /\bsigntool\b/iu,
];

/** `secrets` in any expression, except the repository's own `secrets.GITHUB_TOKEN`. */
const SECRETS = /\bsecrets\b(?!\s*\.\s*GITHUB_TOKEN\b)/u;

export function workflowFiles(root: string): string[] {
  return listFiles(root, [".github/workflows"], [".yml", ".yaml"]);
}

export function ciWorkflowViolations(root: string): Violation[] {
  const violations: Violation[] = [];
  for (const file of workflowFiles(root)) {
    const lines = new LineCounter();
    const document = parseDocument(readFileSync(join(root, file), "utf8"), { lineCounter: lines });
    if (document.errors.length > 0) {
      violations.push({ file, rule: "ci-unparsable" });
      continue;
    }
    const lineOf = (node: Node | null | undefined): number | undefined =>
      node?.range === undefined || node.range === null ? undefined : lines.linePos(node.range[0]).line;
    const report = (rule: string, node: Node | null | undefined): void => {
      const line = lineOf(node);
      violations.push(line === undefined ? { file, rule } : { file, rule, line });
    };
    const walk = (node: unknown): void => {
      if (isMap(node)) {
        for (const pair of node.items) {
          walk(pair);
        }
      } else if (isSeq(node)) {
        for (const item of node.items) {
          walk(item);
        }
      } else if (isPair(node)) {
        const key = isScalar(node.key) ? String(node.key.value) : "";
        const value = node.value as Node | null;
        if (isScalar(node.key) && SECRETS.test(key)) {
          report("ci-secret", node.key);
        }
        if (key === "environment") {
          report("ci-environment", node.key as Node);
        }
        if (key === "uses" && isScalar(value) && typeof value.value === "string") {
          const action = value.value.toLowerCase();
          if (RELEASE_ACTIONS.some((name) => action === name || action.startsWith(`${name}@`) || action.startsWith(`${name}/`))) {
            report("ci-release-action", value);
          }
        }
        if (key === "run" && isScalar(value) && typeof value.value === "string") {
          const command = value.value;
          if (RELEASE_COMMANDS.some((pattern) => pattern.test(command))) {
            report("ci-release-command", value);
          }
        }
        if (key === "permissions" && grantsContentsWrite(value)) {
          report("ci-contents-write", value);
        }
        walk(value);
      } else if (isScalar(node) && typeof node.value === "string" && SECRETS.test(node.value)) {
        report("ci-secret", node);
      }
    };
    walk(document.contents);
  }
  return violations;
}

function grantsContentsWrite(value: Node | null): boolean {
  if (isScalar(value)) {
    return value.value === "write-all";
  }
  if (isMap(value)) {
    return value.items.some((pair) => isScalar(pair.key) && pair.key.value === "contents" && isScalar(pair.value) && pair.value.value === "write");
  }
  return false;
}
