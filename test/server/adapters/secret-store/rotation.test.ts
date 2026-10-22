import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MASTER_KEY_FILE, parseMasterKey, resolveMasterKey } from "../../../../src/server/adapters/secret-store/master-key.ts";
import { LOCAL_MASTER_KEY_ROTATION, ServerMasterKeyRotation } from "../../../../src/server/adapters/secret-store/rotation.ts";
import { tempDataDir } from "../../../tools/sqlite.ts";

function secretsDir(): string {
  const dir = join(tempDataDir("amber-rotate-"), "secrets");
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

describe("ServerMasterKeyRotation", () => {
  it("managed_persistent: writes a new master.key and switches the running store to it", async () => {
    const dir = secretsDir();
    const before = resolveMasterKey({ mode: "server", env: {}, secretsDir: dir, hasEnvelopes: () => false });
    const swapped: Buffer[] = [];
    const rotation = new ServerMasterKeyRotation({ keyMode: "managed_persistent", secretsDir: dir, store: { replaceMasterKey: (key) => void swapped.push(Buffer.from(key)) } });
    await rotation.rotate();
    const written = parseMasterKey(readFileSync(join(dir, MASTER_KEY_FILE), "utf8"), "file");
    expect(swapped).toEqual([written]);
    expect(before.state === "present" && before.key.equals(written)).toBe(false);
  });

  it("external_env and local mode leave the key alone", async () => {
    const dir = secretsDir();
    const swapped: unknown[] = [];
    await new ServerMasterKeyRotation({ keyMode: "external_env", secretsDir: dir, store: { replaceMasterKey: (key) => void swapped.push(key) } }).rotate();
    await LOCAL_MASTER_KEY_ROTATION.rotate();
    expect(swapped).toEqual([]);
    expect(resolveMasterKey({ mode: "server", env: { AMBER_SECRET_KEY: randomBytes(32).toString("base64") }, secretsDir: dir, hasEnvelopes: () => false }).state).toBe("present");
  });
});
