import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TRASH_RETENTION_MS } from "../../src/server/domain/content.ts";
import { listenAddress, parsePublicOrigin, readConfig } from "../../src/server/compose.ts";
import { SERVER_PORT_DEFAULT } from "../../src/shared/defaults.ts";
import { composeServerStack } from "../fixtures/server/composed-stack.ts";

const SERVER_ENV = { AMBER_MODE: "server", AMBER_DATA_DIR: "/data", AMBER_BIN_DIR: "/opt/amber/bin", AMBER_PUBLIC_ORIGIN: "https://amber.example.com" };

describe("readConfig", () => {
  it("reads the server-mode environment: mode, directories, log level, public origin and trusted proxies", () => {
    const config = readConfig({ ...SERVER_ENV, AMBER_TRUSTED_PROXY_CIDRS: " 172.18.0.0/16, ,10.0.0.0/8 " });
    expect(config).toMatchObject({
      mode: "server",
      dataDir: "/data",
      binDir: "/opt/amber/bin",
      logLevel: "info",
      publicOrigin: "https://amber.example.com",
      trustedProxyCidrs: ["172.18.0.0/16", "10.0.0.0/8"],
    });
    expect(readConfig(SERVER_ENV)).toMatchObject({ trustedProxyCidrs: [] });
  });

  it("refuses an unknown mode and a server without a public origin", () => {
    expect(() => readConfig({ ...SERVER_ENV, AMBER_MODE: "cloud" })).toThrow(/AMBER_MODE/);
    const { AMBER_PUBLIC_ORIGIN: _omitted, ...withoutOrigin } = SERVER_ENV;
    expect(() => readConfig(withoutOrigin)).toThrow(/AMBER_PUBLIC_ORIGIN/);
  });
});

describe("parsePublicOrigin", () => {
  it("accepts https origins and http only on a loopback host", () => {
    expect(parsePublicOrigin("https://amber.example.com")).toBe("https://amber.example.com");
    expect(parsePublicOrigin("https://amber.example.com:8443/")).toBe("https://amber.example.com:8443");
    expect(parsePublicOrigin("http://127.0.0.1:4175")).toBe("http://127.0.0.1:4175");
    expect(parsePublicOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("rejects plain http elsewhere, paths, credentials and non-origins", () => {
    for (const value of ["http://amber.example.com", "https://amber.example.com/app", "https://u:p@amber.example.com", "amber.example.com", "https://amber.example.com?x=1", "HTTPS://Amber.example.com", ""]) {
      expect(() => parsePublicOrigin(value), value).toThrow(/AMBER_PUBLIC_ORIGIN/);
    }
  });
});

describe("listenAddress", () => {
  it("defaults to all interfaces on SERVER_PORT_DEFAULT and validates the port", () => {
    expect(listenAddress({})).toEqual({ host: "127.0.0.1", port: SERVER_PORT_DEFAULT });
    expect(listenAddress({ AMBER_HOST: "" })).toEqual({ host: "127.0.0.1", port: SERVER_PORT_DEFAULT });
    expect(listenAddress({ AMBER_HOST: "0.0.0.0" })).toEqual({ host: "0.0.0.0", port: SERVER_PORT_DEFAULT });
    expect(listenAddress({ AMBER_HOST: "127.0.0.1", AMBER_PORT: "4175" })).toEqual({ host: "127.0.0.1", port: 4175 });
    expect(() => listenAddress({ AMBER_PORT: "http" })).toThrow(/AMBER_PORT/);
  });
});

describe("compose lifecycle", () => {
  it("lets a stop that arrives during the startup sweep finish cleanly", async () => {
    const stack = await composeServerStack();
    const background = stack.composition.startBackground();
    await stack.close();
    await expect(background).resolves.toBeUndefined();
  });

  it("purges expired trash at start-up and removes its files, keeping what is still restorable", async () => {
    const stack = await composeServerStack();
    try {
      const { id: userId } = await stack.createUser("alice");
      const now = Date.now();
      const seed = (contentId: string, trashedAt: number) => {
        const assetId = `${contentId}A`;
        const storageRef = `assets/${userId}/${contentId}/${assetId}`;
        mkdirSync(join(stack.dataDir, "assets", userId, contentId), { recursive: true });
        writeFileSync(join(stack.dataDir, storageRef), "media");
        stack.composition.repository.withTransaction((scope) => {
          scope.contents.insert({ id: contentId, userId, source: { kind: "local" }, processingStatus: "succeeded", createdAt: 1, updatedAt: 1 });
          scope.mediaAssets.insert({
            id: assetId, userId, contentId, kind: "managed_upload", storageRef, mimeType: "video/mp4", sizeBytes: 5, availability: "available", retentionPolicy: "keep", createdAt: 1,
          });
          scope.contents.trash(userId, contentId, trashedAt);
        });
        return join(stack.dataDir, storageRef);
      };
      const expiredFile = seed("01EXPIREDCONTENT0000000000", now - TRASH_RETENTION_MS - 1);
      const keptFile = seed("01KEPTCONTENT0000000000000", now - 1000);
      await stack.composition.startBackground();
      await vi.waitFor(() => expect(existsSync(expiredFile)).toBe(false));
      expect(existsSync(join(stack.dataDir, "assets", userId, "01EXPIREDCONTENT0000000000"))).toBe(false);
      expect(existsSync(keptFile)).toBe(true);
      expect(stack.composition.repository.withTransaction((scope) => scope.contents.listTrashedIds(userId))).toEqual(["01KEPTCONTENT0000000000000"]);
    } finally {
      // Waits for the trash timer and the file worker before the database closes.
      await stack.close();
    }
  });
});
