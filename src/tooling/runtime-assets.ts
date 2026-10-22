import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readZip } from "./zip-reader.ts";

/**
 * The Amber Runtime Assets release this tree is built and tested with: its tag (also
 * `manifest.json` `version`) and the SHA256 of its `SHA256SUMS`. Pinning the digest of the
 * checksum list itself is what makes every per-file hash in it trustworthy: a directory
 * passed with `--assets`, wherever it came from, is used only when its `SHA256SUMS` is
 * byte-for-byte the pinned one.
 */
export const RUNTIME_ASSETS_VERSION = "runtime-assets-2026.10.21";
export const RUNTIME_ASSETS_SUMS_SHA256 = "44de90ff887b9be736a0111a6a7f7c996939e3801dd383264855ce89cbf01214";

/** Local working copy of the pinned Amber Runtime Assets release. */
export const DEFAULT_ASSETS_DIR = `amber-runtime-assets/release/${RUNTIME_ASSETS_VERSION}`;

export const SHA256SUMS_FILE = "SHA256SUMS";
export const RUNTIME_MANIFEST_FILE = "manifest.json";

export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      sums.set(match[2], match[1]);
    }
  }
  return sums;
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Reads `SHA256SUMS` from `assetsDir` and refuses it unless its own SHA256 is
 * `expectedSha256`, before any hash listed in it is trusted.
 */
export function readPinnedSums(assetsDir: string, expectedSha256: string = RUNTIME_ASSETS_SUMS_SHA256): Map<string, string> {
  const data = readFileSync(join(assetsDir, SHA256SUMS_FILE));
  const actual = sha256(data);
  if (actual !== expectedSha256) {
    throw new Error(
      `${SHA256SUMS_FILE} in ${assetsDir} is not the pinned Runtime Assets checksum list: expected SHA256 ${expectedSha256}, got ${actual}`,
    );
  }
  return parseSha256Sums(data.toString("utf8"));
}

/** Reads an asset of the release and checks it against `SHA256SUMS` before anything uses it. */
export function readVerifiedAsset(assetsDir: string, sums: Map<string, string>, file: string): Buffer {
  const expected = sums.get(file);
  if (expected === undefined) {
    throw new Error(`${file} is not listed in SHA256SUMS`);
  }
  const data = readFileSync(join(assetsDir, file));
  const actual = sha256(data);
  if (actual !== expected) {
    throw new Error(`SHA256 mismatch for ${file}: expected ${expected}, got ${actual}`);
  }
  return data;
}

/**
 * Burn-in fonts: the regular weight of Noto Sans SC, which the
 * ASS styles name, with its SIL OFL 1.1 text. They go to `fonts/` beside `bin/`, where the
 * server looks for them (`AMBER_BIN_DIR/../fonts`).
 */
export const FONTS_DIR = "fonts";
export const FONT_ARCHIVE = "18_NotoSansSC.zip";
export const FONT_LICENSE = "OFL.txt";
export const FONT_ASSETS = [FONT_ARCHIVE, FONT_LICENSE] as const;
const FONT_MEMBERS = ["NotoSansSC-Regular.otf"] as const;
/** File names `placeFonts` writes. */
export const FONT_OUTPUTS = [...FONT_MEMBERS, FONT_LICENSE] as const;

/** Writes the verified fonts and licence into `outDir`; returns what was placed with its SHA256. */
export function placeFonts(assetsDir: string, sums: Map<string, string>, outDir: string): Array<{ file: string; sha256: string }> {
  const zip = readZip(readVerifiedAsset(assetsDir, sums, FONT_ARCHIVE));
  const files: Array<{ file: string; data: Buffer }> = FONT_MEMBERS.map((member) => {
    const entry = zip.find((item) => item.name === member);
    if (entry === undefined) {
      throw new Error(`${member} not found in ${FONT_ARCHIVE}`);
    }
    return { file: member, data: entry.read() };
  });
  files.push({ file: FONT_LICENSE, data: readVerifiedAsset(assetsDir, sums, FONT_LICENSE) });
  mkdirSync(outDir, { recursive: true });
  return files.map(({ file, data }) => {
    writeFileSync(join(outDir, file), data);
    return { file, sha256: sha256(data) };
  });
}
