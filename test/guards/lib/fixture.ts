import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FIXTURES = join(import.meta.dirname, "..", "fixtures");

export function fixtureRoot(name: string): string {
  return join(FIXTURES, name);
}

/**
 * Secret-scan counter-examples are committed with `{` `}` inside each secret so the
 * repository itself never contains a match. This writes the de-braced files to a
 * temporary directory and returns it with the file list.
 */
export function materializeTemplates(name: string): { root: string; files: string[] } {
  const source = fixtureRoot(name);
  const root = mkdtempSync(join(tmpdir(), "amber-guard-"));
  const files: string[] = [];
  for (const entry of readdirSync(source)) {
    if (!entry.endsWith(".tpl")) {
      continue;
    }
    const target = entry.slice(0, -".tpl".length);
    writeFileSync(join(root, target), readFileSync(join(source, entry), "utf8").replace(/[{}]/g, ""));
    files.push(target);
  }
  return { root, files: files.sort() };
}
