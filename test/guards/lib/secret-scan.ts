import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Violation } from "./files.ts";

interface SecretRule {
  id: string;
  pattern: RegExp;
  /** Optional extra check on the captured value (group 1), e.g. entropy. */
  accept?: (value: string) => boolean;
}

/** Values that are clearly placeholders are never findings. */
export const PLACEHOLDER = /<[^>]*>|example\.(com|org)|127\.0\.0\.1|localhost|x{4,}|\*{3,}|\.\.\.|changeme|your[_-]/i;

// Assembled at runtime so this file does not contain the marker it searches for.
const PEM_PRIVATE_KEY = new RegExp(["-----BEGIN ", "(?:[A-Z0-9]+ )*", "PRIVATE KEY-----"].join(""));

const RULES: readonly SecretRule[] = [
  { id: "openai-style-key", pattern: /\bsk-(?:proj-|ant-)?([A-Za-z0-9_-]{20,})/ },
  { id: "underscore-sk-key", pattern: /\bsk_([A-Za-z0-9]{32,})/ },
  { id: "aws-access-key-id", pattern: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/ },
  { id: "github-token", pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/ },
  { id: "bilibili-sessdata", pattern: /SESSDATA\s*[=:]\s*["']?([^\s"';&]{16,})/ },
  { id: "cookie-header", pattern: /\bCookie:\s*([^\s;=]+=[^\s;]{16,})/i },
  { id: "pem-private-key", pattern: PEM_PRIVATE_KEY },
  {
    id: "env-secret-assignment",
    pattern: /^\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:SECRET|API_KEY|TOKEN|PASSWORD)[A-Z0-9_]*\s*=\s*["']?([^\s"'$]{8,})/m,
  },
  {
    id: "high-entropy-assignment",
    pattern: /(?:api[_-]?key|secret|token|passw(?:or)?d|bearer)["']?\s*[:=]\s*["']([A-Za-z0-9+/_.=-]{24,})["']/i,
    accept: (value) => shannonEntropy(value) >= 3.5,
  },
];

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Tracked and untracked-but-not-ignored files, the set that could be committed. */
export function committableFiles(root: string): string[] {
  const output = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" });
  return output.split("\0").filter((file) => file.length > 0);
}

/**
 * Credential-scan guard: high-probability credential leaks. Reports only file and rule id, never the
 * matched text. It does not prove the absence of private endpoints; those still need
 * human diff review.
 */
export function secretScan(root: string, files: readonly string[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    let content: Buffer;
    try {
      content = readFileSync(join(root, file));
    } catch {
      continue;
    }
    if (content.includes(0)) {
      continue;
    }
    const lines = content.toString("utf8").split(/\r?\n/);
    for (const rule of RULES) {
      const hit = lines.some((line) => {
        const match = rule.pattern.exec(line);
        if (!match) {
          return false;
        }
        const value = match[1] ?? match[0];
        return !PLACEHOLDER.test(value) && (rule.accept?.(value) ?? true);
      });
      if (hit) {
        violations.push({ file, rule: rule.id });
      }
    }
  }
  return violations;
}
