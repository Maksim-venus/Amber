import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { SIDECAR_SHUTDOWN_GRACE_MS } from "../shared/defaults.ts";

/**
 * `pnpm dev`: the local-mode backend under `node --watch` plus the Vite dev server.
 *
 * Everything lives in `.amber-dev/` (0700): a persistent development master key (0600,
 * generated once so stored credentials survive restarts) and the data directory. The
 * sidecar token and the file-grant key are fresh on every start and only ever exist in
 * process environments. The backend changes port on each watch restart, so a stable
 * forwarding proxy sits between Vite and it; Vite's proxy adds the token, so the browser
 * never sees it. Nothing secret is printed.
 */

export interface DevPaths {
  dir: string;
  dataDir: string;
  masterKeyFile: string;
  binDir: string;
}

export function devPaths(root: string): DevPaths {
  const dir = join(root, ".amber-dev");
  return { dir, dataDir: join(dir, "data"), masterKeyFile: join(dir, "master.key"), binDir: join(root, ".amber-tools", "bin") };
}

/** Standard padded Base64 of 32 bytes, the form the backend accepts in `AMBER_SECRET_KEY`. */
const MASTER_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Returns the development master key, creating `.amber-dev/` (0700) and the key file
 * (0600) on first use. A malformed existing file is an error, never silently replaced:
 * replacing it would orphan the credentials stored with the old key.
 */
export function ensureDevMasterKey(paths: Pick<DevPaths, "dir" | "masterKeyFile">): string {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  chmodSync(paths.dir, 0o700);
  if (!existsSync(paths.masterKeyFile)) {
    writeFileSync(paths.masterKeyFile, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600, flag: "wx" });
  }
  chmodSync(paths.masterKeyFile, 0o600);
  const key = readFileSync(paths.masterKeyFile, "utf8").trim();
  if (!MASTER_KEY_PATTERN.test(key)) {
    throw new Error(`${paths.masterKeyFile} is not a padded Base64 key of 32 bytes; move it away to start over`);
  }
  return key;
}

/** A fresh one-time secret: 32 random bytes as base64url (43 characters). */
export function oneTimeSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** The port of a sidecar `READY {"port":…}` line, or undefined for any other line. */
export function parseReadyPort(line: string): number | undefined {
  if (!line.startsWith("READY ")) {
    return undefined;
  }
  try {
    const port: unknown = (JSON.parse(line.slice("READY ".length)) as { port?: unknown }).port;
    return typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
  } catch {
    return undefined;
  }
}

export interface BackendSecrets {
  masterKey: string;
  token: string;
  fileGrantKey: string;
}

/** The sidecar environment: the parent's, with every `AMBER_` variable replaced by the dev values. */
export function backendEnv(parent: NodeJS.ProcessEnv, paths: DevPaths, secrets: BackendSecrets): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(parent).filter(([name]) => !name.startsWith("AMBER_")));
  return {
    ...env,
    AMBER_MODE: "local",
    AMBER_DATA_DIR: paths.dataDir,
    AMBER_BIN_DIR: paths.binDir,
    AMBER_SECRET_KEY: secrets.masterKey,
    AMBER_SIDECAR_TOKEN: secrets.token,
    AMBER_FILE_GRANT_KEY: secrets.fileGrantKey,
  };
}

/** Vite's environment: the parent's without any `AMBER_` variable, plus the proxy target and token. */
export function viteEnv(parent: NodeJS.ProcessEnv, backend: string, token: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(parent).filter(([name]) => !name.startsWith("AMBER_")));
  return { ...env, AMBER_DEV_BACKEND: backend, AMBER_DEV_TOKEN: token };
}

/** Hop-by-hop headers are not forwarded (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);

function forwardable(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())));
}

/**
 * A loopback HTTP forwarder to whatever port `target()` currently reports. Bodies are
 * streamed both ways, so server-sent events pass through unbuffered. Until the backend is
 * ready it answers 503.
 */
export function startForwardProxy(target: () => number | undefined): Promise<{ server: Server; url: string }> {
  const server = createServer((incoming, outgoing) => {
    const port = target();
    if (port === undefined) {
      outgoing.writeHead(503, { "content-type": "text/plain" }).end("backend not ready\n");
      return;
    }
    const upstream = request(
      { host: "127.0.0.1", port, method: incoming.method, path: incoming.url, headers: forwardable(incoming.headers) },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, forwardable(response.headers));
        outgoing.flushHeaders();
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502, { "content-type": "text/plain" }).end("backend unavailable\n");
      } else {
        outgoing.destroy();
      }
    });
    // A closed browser connection (an SSE tab going away) ends the upstream request too.
    outgoing.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolvePromise({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function exited(child: ChildProcess): Promise<void> {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolvePromise) => child.once("exit", () => resolvePromise()));
}

async function main(): Promise<void> {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const paths = devPaths(root);
  const masterKey = ensureDevMasterKey(paths);
  mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  if (!existsSync(paths.binDir)) {
    process.stderr.write(`warning: ${paths.binDir} is missing; run \`pnpm setup:tools\` for media tools\n`);
  }
  const token = oneTimeSecret();
  const secrets: BackendSecrets = { masterKey, token, fileGrantKey: oneTimeSecret() };

  let backendPort: number | undefined;
  const proxy = await startForwardProxy(() => backendPort);

  // `--watch` follows the entry's import graph (src/server and src/shared); the stdin pipe
  // stays open for the sidecar's lifetime and is inherited by every restarted child.
  const backend = spawn(process.execPath, ["--watch", "--watch-preserve-output", join("src", "server", "main.ts")], {
    cwd: root,
    env: backendEnv(process.env, paths, secrets),
    stdio: ["pipe", "pipe", "inherit"],
  });
  createInterface({ input: backend.stdout }).on("line", (line) => {
    const port = parseReadyPort(line);
    if (port === undefined) {
      process.stdout.write(`${line}\n`);
      return;
    }
    backendPort = port;
    process.stdout.write("backend ready\n");
  });

  const vite = spawn(process.execPath, [join(root, "node_modules", "vite", "bin", "vite.js")], {
    cwd: root,
    env: viteEnv(process.env, proxy.url, token),
    stdio: "inherit",
  });

  let stopping = false;
  const stop = async (code: number): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    // Closing stdin asks the sidecar to shut down; the watcher itself then gets SIGTERM.
    backend.stdin.end();
    vite.kill("SIGTERM");
    const timer = setTimeout(() => {
      backend.kill("SIGKILL");
      vite.kill("SIGKILL");
    }, SIDECAR_SHUTDOWN_GRACE_MS);
    setTimeout(() => backend.kill("SIGTERM"), 200).unref();
    await Promise.all([exited(backend), exited(vite)]);
    clearTimeout(timer);
    proxy.server.close();
    process.exitCode = code;
  };
  backend.once("exit", (code) => void stop(code ?? 1));
  vite.once("exit", (code) => void stop(code ?? 1));
  process.on("SIGINT", () => void stop(0));
  process.on("SIGTERM", () => void stop(0));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
