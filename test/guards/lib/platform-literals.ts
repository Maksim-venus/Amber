import ts from "typescript";
import { lineOf, listFiles, parseSource, TS_EXTENSIONS, visit, type Violation } from "./files.ts";

const PLATFORM_LITERALS = new Set(["bilibili", "youtube"]);

/**
 * Platform-literal guard: application and pipeline code never branch on platform identity.
 * The literals are enumerated in the domain and handled in `adapters/platform/*` only.
 */
export function platformLiterals(root: string): Violation[] {
  const violations: Violation[] = [];
  for (const file of listFiles(root, ["src/server/application", "src/server/pipeline"], TS_EXTENSIONS)) {
    const source = parseSource(root, file);
    visit(source, (node) => {
      if (ts.isStringLiteralLike(node) && PLATFORM_LITERALS.has(node.text) && !ts.isImportDeclaration(node.parent)) {
        violations.push({ file, rule: "platform-literal", line: lineOf(source, node) });
      }
    });
  }
  return violations;
}
