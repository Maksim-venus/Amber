import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/** Repository root as seen from this file. */
export const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/** Counter-example trees live here; real-repository scans skip them. */
const FIXTURES_DIR = ["test", "guards", "fixtures"].join("/");

const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist"]);

export interface Violation {
  /** Path relative to the scanned root, always with forward slashes. */
  file: string;
  rule: string;
  line?: number;
}

export function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** Lists files under `root/<dir>` for each dir, relative to `root`, skipping build output and guard fixtures. */
export function listFiles(root: string, dirs: readonly string[], extensions: readonly string[]): string[] {
  const result: string[] = [];
  const walk = (absolute: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(absolute);
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(absolute, entry);
      const rel = toPosix(relative(root, child));
      if (SKIPPED_DIRS.has(entry) || rel === FIXTURES_DIR) {
        continue;
      }
      if (statSync(child).isDirectory()) {
        walk(child);
      } else if (extensions.some((extension) => entry.endsWith(extension))) {
        result.push(rel);
      }
    }
  };
  for (const dir of dirs) {
    walk(join(root, dir));
  }
  return result.sort();
}

export const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

export function parseSource(root: string, file: string): ts.SourceFile {
  const text = readFileSync(join(root, file), "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

export function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** Depth-first visit of every node in a source file. */
export function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

export function isUnder(file: string, prefix: string): boolean {
  return file === prefix || file.startsWith(`${prefix}/`);
}
