import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MASTER_KEY_FILE, parseMasterKey, replaceMasterKeyFile, resolveMasterKey } from "../../../../src/server/adapters/secret-store/master-key.ts";
import { tempDataDir } from "../../../tools/sqlite.ts";

const encoded = () => randomBytes(32).toString("base64");

function secretsDir(): string {
  const dir = join(tempDataDir("amber-key-"), "secrets");
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

const none = () => false;

describe("parseMasterKey", () => {
  it("accepts exactly the padded Base64 encoding of 32 bytes, ignoring surrounding whitespace", () => {
    const text = encoded();
    expect(parseMasterKey(`${text}\n`, "x")).toEqual(Buffer.from(text, "base64"));
  });

  it("rejects other lengths and encodings without echoing the value", () => {
    const shortKey = randomBytes(16).toString("base64");
    for (const bad of [shortKey, encoded().replace("=", ""), randomBytes(32).toString("base64url"), "", "not base64 at all"]) {
      let message = "";
      try {
        parseMasterKey(bad, "AMBER_SECRET_KEY");
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/AMBER_SECRET_KEY must be the padded Base64 encoding of 32 random bytes/);
      if (bad !== "") expect(message.includes(bad)).toBe(false);
    }
  });
});

describe("resolveMasterKey: local", () => {
  it("uses AMBER_SECRET_KEY and never looks at or writes a key file", () => {
    const dir = secretsDir();
    const text = encoded();
    expect(resolveMasterKey({ mode: "local", env: { AMBER_SECRET_KEY: text }, secretsDir: dir, hasEnvelopes: none }))
      .toEqual({ state: "present", key: Buffer.from(text, "base64"), source: "env" });
    expect(resolveMasterKey({ mode: "local", env: {}, secretsDir: dir, hasEnvelopes: none }))
      .toEqual({ state: "absent", reason: "not_provided" });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("resolveMasterKey: server", () => {
  it("prefers the environment when no key file exists", () => {
    const text = encoded();
    const dir = secretsDir();
    expect(resolveMasterKey({ mode: "server", env: { AMBER_SECRET_KEY: text }, secretsDir: dir, hasEnvelopes: none }))
      .toMatchObject({ state: "present", source: "env" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("generates a key once at first boot, writes it 0600 and reads the same key afterwards", () => {
    const dir = secretsDir();
    const first = resolveMasterKey({ mode: "server", env: {}, secretsDir: dir, hasEnvelopes: none });
    expect(first).toMatchObject({ state: "present", source: "generated" });
    const file = join(dir, MASTER_KEY_FILE);
    expect(readdirSync(dir)).toEqual([MASTER_KEY_FILE]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const second = resolveMasterKey({ mode: "server", env: {}, secretsDir: dir, hasEnvelopes: () => true });
    expect(second).toMatchObject({ state: "present", source: "file" });
    expect(first.state === "present" && second.state === "present" && first.key.equals(second.key)).toBe(true);
    expect(readFileSync(file, "utf8").trim()).toHaveLength(44);
  });

  it("does not generate a key while envelopes exist without one", () => {
    const dir = secretsDir();
    expect(resolveMasterKey({ mode: "server", env: {}, secretsDir: dir, hasEnvelopes: () => true }))
      .toEqual({ state: "absent", reason: "envelopes_without_key" });
    expect(existsSync(join(dir, MASTER_KEY_FILE))).toBe(false);
  });

  it("refuses to start when both the environment and the key file provide a key", () => {
    const dir = secretsDir();
    writeFileSync(join(dir, MASTER_KEY_FILE), `${encoded()}\n`, { mode: 0o600 });
    expect(() => resolveMasterKey({ mode: "server", env: { AMBER_SECRET_KEY: encoded() }, secretsDir: dir, hasEnvelopes: none }))
      .toThrow(/both present/);
  });

  it("refuses a malformed key file instead of replacing it", () => {
    const dir = secretsDir();
    const file = join(dir, MASTER_KEY_FILE);
    writeFileSync(file, "truncated", { mode: 0o600 });
    expect(() => resolveMasterKey({ mode: "server", env: {}, secretsDir: dir, hasEnvelopes: none })).toThrow(/master\.key must be/);
    expect(readFileSync(file, "utf8")).toBe("truncated");
  });
});

describe("replaceMasterKeyFile", () => {
  it("replaces the key file whole with a fresh private key and leaves no temporary file", () => {
    const dir = secretsDir();
    const first = resolveMasterKey({ mode: "server", env: {}, secretsDir: dir, hasEnvelopes: none });
    const key = replaceMasterKeyFile(dir);
    const file = join(dir, MASTER_KEY_FILE);
    expect(parseMasterKey(readFileSync(file, "utf8"), "file")).toEqual(key);
    expect(first.state === "present" && first.key.equals(key)).toBe(false);
    expect(readdirSync(dir)).toEqual([MASTER_KEY_FILE]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(resolveMasterKey({ mode: "server", env: {}, secretsDir: dir, hasEnvelopes: none })).toMatchObject({ state: "present", source: "file", key });
  });
});
