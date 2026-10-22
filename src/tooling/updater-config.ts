import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UPDATE_MANIFEST_URL } from "../shared/app-identity.ts";

/**
 * Writes the Tauri `--config` overlay that turns on updater artifacts and points the
 * updater at its feed. Signing cannot be turned off: the updater trusts only a `.sig` that
 * matches the public key built into the client, so losing the private key means no further
 * update can ever reach installed clients. There is one stable channel; candidate builds
 * point the updater at a loopback test feed instead.
 *
 * The overlay lives outside `tauri.conf.json` because tauri-cli signs updater artifacts
 * whenever `bundle.createUpdaterArtifacts` is on and then requires
 * `TAURI_SIGNING_PRIVATE_KEY`; iteration builds without the overlay need no private key.
 *
 *   pnpm updater:config [--local-test <url>]
 *
 * By default the endpoint is the single stable feed on GitHub Releases, whatever the version
 * (the `release` build variant). `--local-test` replaces it with a loopback URL for the
 * upgrade test of the `candidate` variant and is the only case that allows plain HTTP.
 */

export const UPDATER_CONFIG_FILE = "dist/desktop/updater.conf.json";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

export interface UpdaterConfig {
  $schema: string;
  bundle: { createUpdaterArtifacts: true };
  plugins: { updater: { endpoints: string[]; dangerousInsecureTransportProtocol?: true } };
}

/** Only an http(s) URL on the loopback host names is a local test endpoint. */
export function localTestEndpoint(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`--local-test needs a URL, got ${url}`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`--local-test only accepts http(s) URLs on 127.0.0.1 or localhost, got ${url}`);
  }
  return parsed.toString();
}

export function renderUpdaterConfig(input: { localTest?: string } = {}): UpdaterConfig {
  const updater: UpdaterConfig["plugins"]["updater"] =
    input.localTest === undefined
      ? { endpoints: [UPDATE_MANIFEST_URL] }
      : { endpoints: [localTestEndpoint(input.localTest)], dangerousInsecureTransportProtocol: true };
  return {
    $schema: "https://schema.tauri.app/config/2",
    bundle: { createUpdaterArtifacts: true },
    plugins: { updater },
  };
}

function parseArgs(argv: readonly string[]): { localTest?: string } {
  let localTest: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--local-test") {
      localTest = argv[++index];
      if (localTest === undefined) {
        throw new Error("--local-test needs a URL");
      }
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return localTest === undefined ? {} : { localTest };
}

function main(): void {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const config = renderUpdaterConfig(parseArgs(process.argv.slice(2)));
  const target = join(root, UPDATER_CONFIG_FILE);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`wrote ${UPDATER_CONFIG_FILE} (${config.plugins.updater.endpoints.join(", ")})`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`updater-config: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
