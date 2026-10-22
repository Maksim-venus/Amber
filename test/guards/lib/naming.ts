import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import ts from "typescript";
import { isUnder, lineOf, listFiles, parseSource, TS_EXTENSIONS, visit, type Violation } from "./files.ts";

/** Test directories that hold cross-module tests or infrastructure and are exempt from mirroring. */
export const DEDICATED_TEST_DIRS = ["test/guards", "test/fixtures", "test/tools", "test/e2e", "test/e2e-real", "test/pipeline-smoke", "test/api-contract"] as const;

/** kebab-case segments separated by dots: `task.ts`, `check-versions.test.ts`, `vite.config.ts`. */
const KEBAB_FILE = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*$/;

/**
 * Naming guard: TypeScript file names are kebab-case, and a test outside the
 * dedicated directories mirrors an existing source file:
 * `test/<path>/<name>.test.ts(x)` ↔ `src/<path>/<name>.ts(x)`.
 */
export function namingAndMirror(root: string): Violation[] {
  const violations: Violation[] = [];
  for (const file of listFiles(root, ["src", "test"], TS_EXTENSIONS)) {
    const stem = basename(file).replace(/\.(ts|tsx|mts|cts)$/, "");
    if (!KEBAB_FILE.test(stem)) {
      violations.push({ file, rule: "file-name-not-kebab-case" });
    }
    if (!isUnder(file, "test") || DEDICATED_TEST_DIRS.some((dir) => isUnder(file, dir))) {
      continue;
    }
    const mirrored = /^test\/(.+)\.test\.(ts|tsx)$/.exec(file);
    if (!mirrored) {
      violations.push({ file, rule: "test-outside-dedicated-dir-not-named-test" });
      continue;
    }
    const base = `src/${mirrored[1]}`;
    if (!existsSync(join(root, `${base}.ts`)) && !existsSync(join(root, `${base}.tsx`))) {
      violations.push({ file, rule: "test-without-mirrored-source" });
    }
  }
  return violations;
}

const MODIFIER_KEYS = new Set(["ctrlKey", "metaKey"]);
const KEY_EVENTS = new Set(["keydown", "keyup", "keypress"]);
const KEY_HANDLER_PROPS = new Set(["onKeyDown", "onKeyUp", "onKeyPress", "onKeyDownCapture", "onKeyUpCapture"]);

/**
 * Shortcut-registry guard: global shortcuts are registered only through `ShortcutRegistry`.
 * A keyboard handler that inspects `ctrlKey` / `metaKey` may live only in a
 * `shortcut-registry` module; plain Enter / Escape / arrow handling in components is fine.
 */
export function shortcutRegistryOnly(root: string): Violation[] {
  const violations: Violation[] = [];
  for (const file of listFiles(root, ["src"], TS_EXTENSIONS)) {
    if (/^shortcut-registry\.(ts|tsx)$/.test(basename(file))) {
      continue;
    }
    const source = parseSource(root, file);
    visit(source, (node) => {
      if (ts.isPropertyAccessExpression(node) && MODIFIER_KEYS.has(node.name.text) && inKeyboardHandler(node)) {
        violations.push({ file, rule: "modifier-shortcut-outside-registry", line: lineOf(source, node) });
      }
    });
  }
  return violations;
}

function inKeyboardHandler(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) {
      continue;
    }
    const hasKeyboardParam = current.parameters.some(
      (parameter) => parameter.type !== undefined && /KeyboardEvent/.test(parameter.type.getText()),
    );
    if (hasKeyboardParam || isKeyHandlerPosition(current)) {
      return true;
    }
  }
  return false;
}

function isKeyHandlerPosition(fn: ts.Node): boolean {
  const parent = fn.parent;
  if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)) {
    const [eventName] = parent.arguments;
    return (
      parent.expression.name.text === "addEventListener" &&
      eventName !== undefined &&
      ts.isStringLiteralLike(eventName) &&
      KEY_EVENTS.has(eventName.text)
    );
  }
  if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)) {
    return KEY_HANDLER_PROPS.has(parent.parent.name.getText());
  }
  return false;
}
