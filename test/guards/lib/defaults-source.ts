import ts from "typescript";
import { lineOf, listFiles, parseSource, TS_EXTENSIONS, visit, type Violation } from "./files.ts";

export const DEFAULTS_FILE = "src/shared/defaults.ts";

/** Names exported by `src/shared/defaults.ts`. */
export function defaultNames(root: string): Set<string> {
  const names = new Set<string>();
  const source = parseSource(root, DEFAULTS_FILE);
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.add(declaration.name.text);
        }
      }
    }
  }
  return names;
}

/**
 * Defaults single-source guard: the named defaults have a single definition in `src/shared/defaults.ts`.
 * Anywhere else, declaring a variable, property, enum member or parameter with one of
 * those names is a second definition.
 */
export function defaultsSingleSource(root: string): Violation[] {
  const names = defaultNames(root);
  const violations: Violation[] = [];
  for (const file of listFiles(root, ["src"], TS_EXTENSIONS)) {
    if (file === DEFAULTS_FILE) {
      continue;
    }
    const source = parseSource(root, file);
    visit(source, (node) => {
      if (
        (ts.isVariableDeclaration(node) ||
          ts.isPropertyAssignment(node) ||
          ts.isPropertyDeclaration(node) ||
          ts.isPropertySignature(node) ||
          ts.isEnumMember(node) ||
          ts.isParameter(node)) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        names.has(node.name.text)
      ) {
        violations.push({ file, rule: "default-redefined", line: lineOf(source, node) });
      }
    });
  }
  return violations;
}
