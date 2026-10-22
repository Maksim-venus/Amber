import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Bundles Amber's own server TypeScript into `dist/server/server.js`. Production
 * dependencies stay external: they are installed next to the bundle from the lockfile,
 * which keeps native modules such as better-sqlite3 out of the bundle.
 *
 * Beside it goes `uninstall-data.js`, the data remover the Windows uninstaller runs with
 * the bundled Node. It uses Node built-ins only, so it is bundled on its own
 * and needs none of the installed dependencies.
 */

export const SERVER_BUNDLE = "dist/server/server.js";
export const UNINSTALL_DATA_BUNDLE = "dist/server/uninstall-data.js";

export function productionDependencies(packageJson: { dependencies?: Record<string, string> }): string[] {
  return Object.keys(packageJson.dependencies ?? {}).sort();
}

async function main(): Promise<void> {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const external = productionDependencies(packageJson);
  const common = {
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
  } as const;
  await build({ ...common, entryPoints: [join(root, "src/server/main.ts")], outfile: join(root, SERVER_BUNDLE), external });
  console.log(`wrote ${SERVER_BUNDLE} (external: ${external.join(", ")})`);
  // No externals: a dependency import would fail beside an uninstaller that has only Node.
  await build({ ...common, entryPoints: [join(root, "src/server/uninstall-data.ts")], outfile: join(root, UNINSTALL_DATA_BUNDLE) });
  console.log(`wrote ${UNINSTALL_DATA_BUNDLE}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
