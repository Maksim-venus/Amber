import { basename } from "node:path";
import ts from "typescript";
import { lineOf, listFiles, parseSource, TS_EXTENSIONS, visit, type Violation } from "./files.ts";
import { I18N_ALLOWLIST, type I18nAllowlistEntry } from "./i18n-allowlist.ts";

/** The i18next initialization file holds the resources by design. */
const EXEMPT_FILES = new Set(["src/web/i18n.ts"]);

/** Attributes whose values are technical, not copy. */
const TECHNICAL_ATTRIBUTES = new Set(["className", "id", "href", "src", "key", "role", "type"]);

const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;
const LATIN_WORD = /[A-Za-z]/;
/** `https://…`, `mailto:…`, `amber://…`: a scheme and no whitespace. */
const URL_LITERAL = /^[a-z][a-z0-9+.-]*:\S*$/i;

/**
 * Whether a literal reads as user-visible copy: any CJK character, or
 * at least two whitespace-separated Latin words that end in `.`, `?`, `!` or contain a comma.
 */
export function looksLikeCopy(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "" || URL_LITERAL.test(trimmed)) {
    return false;
  }
  if (CJK.test(trimmed)) {
    return true;
  }
  const words = trimmed.split(/\s+/).filter((word) => LATIN_WORD.test(word));
  return words.length >= 2 && (/[.?!]$/.test(trimmed) || trimmed.includes(","));
}

/**
 * Hardcoded-copy guard: `src/web/**` carries no hardcoded copy; user-visible text comes from the i18n
 * resources. JSX text, string literals and template literal parts are checked; module
 * specifiers, regular expressions, URLs and technical JSX attributes are not.
 */
export function hardcodedCopy(root: string, allowlist: readonly I18nAllowlistEntry[] = I18N_ALLOWLIST): Violation[] {
  const violations: Violation[] = [];
  for (const file of listFiles(root, ["src/web"], TS_EXTENSIONS)) {
    if (EXEMPT_FILES.has(file) || /\.test\./.test(basename(file))) {
      continue;
    }
    const source = parseSource(root, file);
    visit(source, (node) => {
      const text = literalText(node);
      if (text === undefined || !looksLikeCopy(text) || isTechnicalPosition(node)) {
        return;
      }
      const written = ts.isJsxText(node) ? text.trim() : text;
      if (allowlist.some((entry) => entry.file === file && entry.text === written)) {
        return;
      }
      const line = lineOf(source, node);
      // A template literal yields several parts on one line; report the line once.
      const last = violations.at(-1);
      if (last?.file !== file || last.line !== line) {
        violations.push({ file, rule: "hardcoded-copy", line });
      }
    });
  }
  return violations;
}

function literalText(node: ts.Node): string | undefined {
  if (ts.isJsxText(node)) {
    return node.containsOnlyTriviaWhiteSpaces ? undefined : node.text;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
    return node.text;
  }
  return undefined;
}

function isTechnicalPosition(node: ts.Node): boolean {
  const parent = node.parent;
  if (
    (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
    parent.moduleSpecifier === node
  ) {
    return true;
  }
  if (ts.isExternalModuleReference(parent) || ts.isImportTypeNode(parent.parent)) {
    return true;
  }
  if (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return true;
  }
  // A value anywhere inside a technical attribute, e.g. className={cn("a", flag && "b")}.
  for (let current: ts.Node = parent; !ts.isSourceFile(current); current = current.parent) {
    if (ts.isJsxAttribute(current)) {
      const name = current.name.getText();
      return TECHNICAL_ATTRIBUTES.has(name) || name.startsWith("data-");
    }
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current)) {
      return false;
    }
  }
  return false;
}
