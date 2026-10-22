import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isUnder, listFiles, parseSource, TS_EXTENSIONS, type Violation } from "./files.ts";
import { collectImports, isBareSpecifier, isNodeBuiltin, packageName } from "./imports.ts";

function importViolations(
  root: string,
  scope: string,
  rule: string,
  isForbidden: (ref: { specifier: string; target?: string }) => boolean,
): Violation[] {
  const violations: Violation[] = [];
  for (const file of listFiles(root, [scope], TS_EXTENSIONS)) {
    for (const ref of collectImports(parseSource(root, file), file)) {
      if (isForbidden(ref)) {
        violations.push({ file, rule, line: ref.line });
      }
    }
  }
  return violations;
}

/** Web-imports-server guard: the SPA talks to the server only through `/api`, never by importing server code. */
export function webImportsServer(root: string): Violation[] {
  return importViolations(root, "src/web", "web-imports-server", (ref) =>
    ref.target !== undefined ? isUnder(ref.target, "src/server") : false,
  );
}

const SERVICE_LAYERS = ["src/server/application", "src/server/domain", "src/server/pipeline"] as const;

/** Service-imports-adapter guard: application / domain / pipeline depend on port interfaces, never on adapter implementations. */
export function serviceImportsAdapters(root: string): Violation[] {
  return SERVICE_LAYERS.flatMap((scope) =>
    importViolations(root, scope, "service-imports-adapter", (ref) =>
      ref.target !== undefined ? isUnder(ref.target, "src/server/adapters") : false,
    ),
  );
}

/** Crates that would let the desktop shell serve HTTP, i.e. host business routes itself. */
const HTTP_SERVER_CRATES = ["axum", "actix-web", "warp", "rocket", "tiny_http", "poem", "hyper", "tide", "salvo"];

/**
 * Desktop business-logic guard: the Tauri shell handles windows, dialogs, notifications,
 * links, sidecar lifecycle and system credentials only. It must not import server code, and
 * its Rust side must not pull in an HTTP server.
 */
export function desktopBusinessLogic(root: string): Violation[] {
  const violations = importViolations(root, "src/desktop", "desktop-imports-server", (ref) =>
    ref.target !== undefined ? isUnder(ref.target, "src/server") : false,
  );
  const crateUse = new RegExp(`\\b(${HTTP_SERVER_CRATES.map((name) => name.replace("-", "[-_]")).join("|")})\\b`);
  for (const file of listFiles(root, ["src/desktop"], [".rs", "Cargo.toml"])) {
    const lines = readFileSync(join(root, file), "utf8").split(/\r?\n/);
    lines.forEach((text, index) => {
      const code = text.replace(/\/\/.*$|#.*$/, "");
      const isRustUse = file.endsWith(".rs") && /\b(use|extern crate)\b/.test(code);
      const isDependency =
        file.endsWith("Cargo.toml") && (/^\s*[\w-]+\s*=/.test(code) || /^\s*\[[\w.-]*dependencies\.[\w-]+\]/.test(code));
      if ((isRustUse || isDependency) && crateUse.test(code)) {
        violations.push({ file, rule: "desktop-http-server", line: index + 1 });
      }
    });
  }
  return violations;
}

/** devDependencies approved for use by `src/tooling`; each addition needs approval like any dependency. */
export const TOOLING_ALLOWED_PACKAGES: readonly string[] = ["esbuild"];

/**
 * Tooling-imports guard: tooling depends only on Node built-ins, approved tooling-only
 * devDependencies and pure-data modules of `src/shared` (shared files that import no packages themselves).
 */
export function toolingImports(root: string): Violation[] {
  const violations: Violation[] = [];
  for (const file of listFiles(root, ["src/tooling"], TS_EXTENSIONS)) {
    for (const ref of collectImports(parseSource(root, file), file)) {
      if (isBareSpecifier(ref.specifier)) {
        if (!isNodeBuiltin(ref.specifier) && !TOOLING_ALLOWED_PACKAGES.includes(packageName(ref.specifier))) {
          violations.push({ file, rule: "tooling-imports-package", line: ref.line });
        }
        continue;
      }
      const target = ref.target ?? "";
      if (isUnder(target, "src/tooling")) {
        continue;
      }
      if (!isUnder(target, "src/shared")) {
        violations.push({ file, rule: "tooling-imports-layer", line: ref.line });
      } else if (!isPureData(root, target)) {
        violations.push({ file, rule: "tooling-imports-impure-shared", line: ref.line });
      }
    }
  }
  return violations;
}

function isPureData(root: string, target: string): boolean {
  const file = target.endsWith(".ts") ? target : `${target}.ts`;
  if (!existsSync(join(root, file))) {
    return false;
  }
  return collectImports(parseSource(root, file), file).every((ref) => !isBareSpecifier(ref.specifier));
}
