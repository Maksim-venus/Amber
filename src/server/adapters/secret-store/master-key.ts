import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { RunMode } from "../../../shared/enums.ts";

export const MASTER_KEY_BYTES = 32;
export const MASTER_KEY_FILE = "master.key";
export const MASTER_KEY_ENV = "AMBER_SECRET_KEY";

/** Standard padded Base64 of exactly 32 bytes: 43 characters and one `=`. */
const MASTER_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

export type MasterKeyResolution =
  | { state: "present"; key: Buffer; source: "env" | "file" | "generated" }
  /**
   * No usable key: the content library still opens and stored credentials report
   * `unavailable`. A key is never generated while envelopes exist, because a new key
   * would silently orphan them.
   */
  | { state: "absent"; reason: "not_provided" | "envelopes_without_key" };

export interface ResolveMasterKeyInput {
  mode: RunMode;
  env: Readonly<Record<string, string | undefined>>;
  /** `<AMBER_DATA_DIR>/secrets`, already created with mode 0700. */
  secretsDir: string;
  /** Whether any secret envelope is stored; consulted only before a first-boot generation. */
  hasEnvelopes: () => boolean;
}

/** Parses a master key. The message never contains the offending value. */
export function parseMasterKey(text: string, origin: string): Buffer {
  const trimmed = text.trim();
  const key = MASTER_KEY_PATTERN.test(trimmed) ? Buffer.from(trimmed, "base64") : undefined;
  if (key === undefined || key.length !== MASTER_KEY_BYTES) {
    throw new Error(`${origin} must be the padded Base64 encoding of ${MASTER_KEY_BYTES} random bytes`);
  }
  return key;
}

/**
 * Master key sources.
 * - local: only `AMBER_SECRET_KEY`, injected by the desktop shell from Credential Manager.
 * - server: `AMBER_SECRET_KEY`, else `<dataDir>/secrets/master.key`, else a key generated
 *   once at the instance's first boot and written to that file. Both env and file present
 *   is a startup failure: silently preferring one could switch keys under stored envelopes.
 * A malformed key is a startup failure as well.
 */
export function resolveMasterKey(input: ResolveMasterKeyInput): MasterKeyResolution {
  const envText = input.env[MASTER_KEY_ENV];
  const fromEnv = envText === undefined || envText === "" ? undefined : parseMasterKey(envText, MASTER_KEY_ENV);
  if (input.mode === "local") {
    return fromEnv === undefined ? { state: "absent", reason: "not_provided" } : { state: "present", key: fromEnv, source: "env" };
  }
  const file = join(input.secretsDir, MASTER_KEY_FILE);
  const fileExists = existsSync(file);
  if (fromEnv !== undefined && fileExists) {
    throw new Error(`${MASTER_KEY_ENV} and secrets/${MASTER_KEY_FILE} are both present; keep exactly one of them`);
  }
  if (fromEnv !== undefined) {
    return { state: "present", key: fromEnv, source: "env" };
  }
  if (fileExists) {
    return { state: "present", key: parseMasterKey(readFileSync(file, "utf8"), `secrets/${MASTER_KEY_FILE}`), source: "file" };
  }
  if (input.hasEnvelopes()) {
    return { state: "absent", reason: "envelopes_without_key" };
  }
  const key = randomBytes(MASTER_KEY_BYTES);
  writeKeyFileOnce(file, key);
  return { state: "present", key, source: "generated" };
}

/**
 * Writes the key file durably and without ever replacing an existing one: the bytes go to
 * a private temporary file first, which is then hard-linked into place (failing if the
 * target exists) so a crash cannot leave a truncated key behind.
 */
function writeKeyFileOnce(file: string, key: Buffer): void {
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, `${key.toString("base64")}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, file);
  } finally {
    unlinkSync(temporary);
  }
}

/**
 * Replaces `<secretsDir>/master.key` with a fresh key: written to a private temporary file,
 * synced, then renamed over the old one, so a crash leaves either the old or the new key
 * whole. Only for the "reset all credentials" step that follows the removal of every
 * envelope; returns the new key.
 */
export function replaceMasterKeyFile(secretsDir: string): Buffer {
  const file = join(secretsDir, MASTER_KEY_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  const key = randomBytes(MASTER_KEY_BYTES);
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeSync(fd, `${key.toString("base64")}\n`);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  renameSync(temporary, file);
  syncDirectory(secretsDir);
  return key;
}

/** Makes a rename durable; Windows cannot open a directory for syncing and has no need to. */
function syncDirectory(dir: string): void {
  if (process.platform === "win32") {
    return;
  }
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
