import { builtinModules } from "node:module";
import { dirname, join, normalize, relative } from "node:path";
import ts from "typescript";
import { lineOf, toPosix, visit } from "./files.ts";

export interface ImportRef {
  specifier: string;
  line: number;
  /** For relative specifiers: the target path relative to the scanned root. */
  target?: string;
}

/**
 * Every module reference in a file: static imports and re-exports (type-only included),
 * `import x = require()`, dynamic `import()`, `require()` calls and `import("x").T` types.
 */
export function collectImports(source: ts.SourceFile, file: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const add = (specifierNode: ts.Node): void => {
    if (!ts.isStringLiteralLike(specifierNode)) {
      return;
    }
    const specifier = specifierNode.text;
    const ref: ImportRef = { specifier, line: lineOf(source, specifierNode) };
    if (specifier.startsWith(".")) {
      ref.target = toPosix(normalize(join(dirname(file), specifier)));
    }
    refs.push(ref);
  };
  visit(source, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const [first] = node.arguments;
      if ((isDynamicImport || isRequire) && first) {
        add(first);
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal);
    }
  });
  return refs;
}

const BUILTINS = new Set(builtinModules);

export function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || BUILTINS.has(specifier.split("/")[0] ?? "");
}

export function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/");
}

/** Package name of a bare specifier: `@scope/pkg/sub` → `@scope/pkg`, `pkg/sub` → `pkg`. */
export function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/** Relative path from the scanned root for display, independent of the checkout location. */
export function displayPath(root: string, absolute: string): string {
  return toPosix(relative(root, absolute));
}
