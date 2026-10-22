import ts from "typescript";
import { isUnder, lineOf, listFiles, parseSource, TS_EXTENSIONS, visit, type Violation } from "./files.ts";
import { collectImports, isBareSpecifier, isNodeBuiltin, packageName } from "./imports.ts";

const ADAPTERS = "src/server/adapters";

/**
 * Packages that server code outside adapters and `src/shared` may import. Everything
 * else (vendor SDKs, protocol clients, HTTP frameworks) belongs inside an adapter or
 * the API layer. Extending this list is a dependency decision and needs approval.
 */
export const SERVICE_ALLOWED_PACKAGES: readonly string[] = ["zod", "ulid"];

/** The only server files allowed to wire adapter implementations to ports. */
export const COMPOSITION_ROOTS: readonly string[] = ["src/server/main.ts", "src/server/compose.ts", "src/server/app.ts", "src/server/restore.ts"];

/** Adapter group: `src/server/adapters/<group>/...`. */
function adapterGroup(path: string): string | undefined {
  if (!isUnder(path, ADAPTERS)) {
    return undefined;
  }
  return path.slice(ADAPTERS.length + 1).split("/")[0];
}

/**
 * Vendor-confinement guard: vendor and protocol types stay inside `src/server/adapters/<name>/`.
 * - server code outside adapters and `src/shared` import only approved packages;
 * - adapter groups do not import each other;
 * - only composition roots import adapters;
 * - an adapter does not export declarations whose signatures mention types imported
 *   from third-party packages.
 */
export function vendorConfinement(root: string): Violation[] {
  const violations: Violation[] = [];
  const files = listFiles(root, ["src/server", "src/shared"], TS_EXTENSIONS);
  for (const file of files) {
    const source = parseSource(root, file);
    const group = adapterGroup(file);
    for (const ref of collectImports(source, file)) {
      if (isBareSpecifier(ref.specifier)) {
        const allowed = isNodeBuiltin(ref.specifier) || SERVICE_ALLOWED_PACKAGES.includes(packageName(ref.specifier));
        const mayUseFramework = isUnder(file, "src/server/api") || COMPOSITION_ROOTS.includes(file);
        if (group === undefined && !allowed && !mayUseFramework) {
          violations.push({ file, rule: "service-imports-vendor-package", line: ref.line });
        }
        continue;
      }
      const targetGroup = ref.target === undefined ? undefined : adapterGroup(ref.target);
      if (targetGroup === undefined) {
        continue;
      }
      if (group !== undefined && group !== targetGroup) {
        violations.push({ file, rule: "adapter-imports-other-adapter", line: ref.line });
      } else if (group === undefined && !COMPOSITION_ROOTS.includes(file)) {
        violations.push({ file, rule: "adapter-imported-outside-composition-root", line: ref.line });
      }
    }
    if (group !== undefined) {
      violations.push(...exportedVendorTypes(source, file));
    }
  }
  return violations;
}

function exportedVendorTypes(source: ts.SourceFile, file: string): Violation[] {
  const vendorNames = new Set<string>();
  const vendorNamespaces = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    if (!isBareSpecifier(specifier) || isNodeBuiltin(specifier) || SERVICE_ALLOWED_PACKAGES.includes(packageName(specifier))) {
      continue;
    }
    const clause = statement.importClause;
    if (clause?.name) {
      vendorNames.add(clause.name.text);
    }
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      vendorNamespaces.add(bindings.name.text);
    } else if (bindings) {
      for (const element of bindings.elements) {
        vendorNames.add(element.name.text);
      }
    }
  }
  const violations: Violation[] = [];
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      if (isBareSpecifier(specifier) && !isNodeBuiltin(specifier)) {
        violations.push({ file, rule: "adapter-reexports-vendor", line: lineOf(source, statement) });
      }
      continue;
    }
    if (!isExported(statement)) {
      continue;
    }
    visit(statement, (node) => {
      if (!ts.isTypeReferenceNode(node) && !ts.isExpressionWithTypeArguments(node)) {
        return;
      }
      const name = ts.isTypeReferenceNode(node) ? node.typeName : node.expression;
      const text = headIdentifier(name);
      const qualified = ts.isQualifiedName(name) || ts.isPropertyAccessExpression(name);
      if (text !== undefined && (vendorNames.has(text) || (qualified && vendorNamespaces.has(text)))) {
        violations.push({ file, rule: "adapter-exports-vendor-type", line: lineOf(source, node) });
      }
    });
  }
  return violations;
}

/** `a` for `a`, `a.b.C` (qualified type name) and `a.b.C` (heritage expression). */
function headIdentifier(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  if (ts.isQualifiedName(node)) {
    return headIdentifier(node.left);
  }
  if (ts.isPropertyAccessExpression(node)) {
    return headIdentifier(node.expression);
  }
  return undefined;
}

function isExported(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}
