import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backendEnv, devPaths, ensureDevMasterKey, oneTimeSecret, parseReadyPort, startForwardProxy, viteEnv } from "../../src/tooling/dev.ts";

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

describe("ensureDevMasterKey", () => {
  it("creates the key once with private permissions and keeps it across starts", () => {
    const paths = devPaths(mkdtempSync(join(tmpdir(), "amber-dev-")));
    const key = ensureDevMasterKey(paths);
    expect(Buffer.from(key, "base64")).toHaveLength(32);
    expect(statSync(paths.dir).mode & 0o777).toBe(0o700);
    expect(statSync(paths.masterKeyFile).mode & 0o777).toBe(0o600);
    expect(ensureDevMasterKey(paths)).toBe(key);
  });

  it("refuses a malformed key file instead of replacing it", () => {
    const paths = devPaths(mkdtempSync(join(tmpdir(), "amber-dev-")));
    ensureDevMasterKey(paths);
    writeFileSync(paths.masterKeyFile, "not-a-key\n");
    expect(() => ensureDevMasterKey(paths)).toThrow(/32 bytes/);
    expect(readFileSync(paths.masterKeyFile, "utf8")).toBe("not-a-key\n");
  });
});

describe("parseReadyPort", () => {
  it("reads the port of READY lines only", () => {
    expect(parseReadyPort('READY {"port":41234,"pid":7}')).toBe(41234);
    expect(parseReadyPort("Restarting 'src/server/main.ts'")).toBeUndefined();
    expect(parseReadyPort("READY {bad json")).toBeUndefined();
    expect(parseReadyPort('READY {"port":0}')).toBeUndefined();
  });
});

describe("environments", () => {
  const paths = devPaths("/repo");
  const secrets = { masterKey: "k".repeat(43) + "=", token: oneTimeSecret(), fileGrantKey: oneTimeSecret() };

  it("gives the backend local mode and fresh secrets, dropping inherited AMBER_ values", () => {
    const env = backendEnv({ PATH: "/bin", AMBER_SECRET_KEY: "stale", AMBER_MODE: "server" }, paths, secrets);
    expect(env).toMatchObject({
      PATH: "/bin",
      AMBER_MODE: "local",
      AMBER_DATA_DIR: join("/repo", ".amber-dev", "data"),
      AMBER_BIN_DIR: join("/repo", ".amber-tools", "bin"),
      AMBER_SECRET_KEY: secrets.masterKey,
      AMBER_SIDECAR_TOKEN: secrets.token,
      AMBER_FILE_GRANT_KEY: secrets.fileGrantKey,
    });
    expect(Buffer.from(secrets.token, "base64url")).toHaveLength(32);
  });

  it("gives Vite only the proxy target and the token, never the backend secrets", () => {
    const env = viteEnv({ PATH: "/bin", AMBER_SECRET_KEY: "x" }, "http://127.0.0.1:1", "t");
    expect(env).toEqual({ PATH: "/bin", AMBER_DEV_BACKEND: "http://127.0.0.1:1", AMBER_DEV_TOKEN: "t" });
  });
});

describe("startForwardProxy", () => {
  it("answers 503 before the backend is ready and then streams to the current port", async () => {
    const backend = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream", "x-path": request.url ?? "" });
      response.write("data: first\n\n");
      setTimeout(() => response.end("data: second\n\n"), 20);
    });
    await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
    closers.push(() => backend.close());
    let port: number | undefined;
    const proxy = await startForwardProxy(() => port);
    closers.push(() => proxy.server.close());

    expect((await fetch(`${proxy.url}/api/health`)).status).toBe(503);
    port = (backend.address() as AddressInfo).port;
    const response = await fetch(`${proxy.url}/api/tasks/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-path")).toBe("/api/tasks/events");
    expect(await response.text()).toBe("data: first\n\ndata: second\n\n");
  });
});
