import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ASSETS_DIR,
  FONT_ASSETS,
  parseSha256Sums,
  placeFonts,
  readPinnedSums,
  RUNTIME_ASSETS_SUMS_SHA256,
  RUNTIME_ASSETS_VERSION,
  sha256,
} from "../../src/tooling/runtime-assets.ts";
import { makeZip } from "../tools/zip.ts";

describe("parseSha256Sums", () => {
  it("reads sha256sum output, including binary-mode markers", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const sums = parseSha256Sums(`${a}  node.zip\n${b} *yt-dlp.exe\n\nnot a line\n`);
    expect([...sums]).toEqual([
      ["node.zip", a],
      ["yt-dlp.exe", b],
    ]);
  });
});

describe("the pinned Runtime Assets release", () => {
  it("is named by its tag and the SHA256 of its SHA256SUMS", () => {
    expect(RUNTIME_ASSETS_VERSION).toBe("runtime-assets-2026.10.21");
    expect(RUNTIME_ASSETS_SUMS_SHA256).toMatch(/^[0-9a-f]{64}$/u);
    expect(DEFAULT_ASSETS_DIR).toBe(`amber-runtime-assets/release/${RUNTIME_ASSETS_VERSION}`);
  });

  it("is the release CI downloads, from the public resource repository", () => {
    const workflow = readFileSync(join(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8");
    const downloads = [...workflow.matchAll(/gh release download (\S+) --repo (\S+)/gu)].map((match) => [match[1], match[2]]);
    expect(downloads).toEqual([[RUNTIME_ASSETS_VERSION, "lifefindsitsway/amber-runtime-assets"]]);
  });
});

describe("readPinnedSums", () => {
  it("parses SHA256SUMS only when its own digest is the pinned one", () => {
    const assets = mkdtempSync(join(tmpdir(), "amber-pinned-"));
    const text = `${"a".repeat(64)}  node.zip\n`;
    writeFileSync(join(assets, "SHA256SUMS"), text);
    expect([...readPinnedSums(assets, sha256(Buffer.from(text)))]).toEqual([["node.zip", "a".repeat(64)]]);
    expect(() => readPinnedSums(assets, "b".repeat(64))).toThrow(/not the pinned Runtime Assets checksum list: expected SHA256 b{64}, got [0-9a-f]{64}/u);
    // Whitespace counts: the pin is over the exact bytes.
    writeFileSync(join(assets, "SHA256SUMS"), `${text}\n`);
    expect(() => readPinnedSums(assets, sha256(Buffer.from(text)))).toThrow(/not the pinned/u);
  });
});

describe("sha256", () => {
  it("hashes bytes as lowercase hex", () => {
    expect(sha256(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("placeFonts", () => {
  function release(members: Array<{ name: string; data: Buffer }>) {
    const assets = mkdtempSync(join(tmpdir(), "amber-fonts-"));
    const zip = makeZip(members.map((member) => ({ ...member, method: 8 as const })));
    const licence = Buffer.from("SIL OPEN FONT LICENSE Version 1.1\n");
    writeFileSync(join(assets, "18_NotoSansSC.zip"), zip);
    writeFileSync(join(assets, "OFL.txt"), licence);
    const sums = new Map([
      ["18_NotoSansSC.zip", sha256(zip)],
      ["OFL.txt", sha256(licence)],
    ]);
    return { assets, sums, out: join(assets, "out", "fonts") };
  }

  it("verifies both assets and places the regular weight with the licence", () => {
    expect(FONT_ASSETS).toEqual(["18_NotoSansSC.zip", "OFL.txt"]);
    const { assets, sums, out } = release([
      { name: "NotoSansSC-Regular.otf", data: Buffer.from("regular") },
      { name: "NotoSansSC-Bold.otf", data: Buffer.from("bold") },
      { name: "LICENSE", data: Buffer.from("licence") },
    ]);
    const placed = placeFonts(assets, sums, out);
    expect(placed).toEqual([
      { file: "NotoSansSC-Regular.otf", sha256: sha256(Buffer.from("regular")) },
      { file: "OFL.txt", sha256: sha256(readFileSync(join(assets, "OFL.txt"))) },
    ]);
    expect(readdirSync(out).sort()).toEqual(["NotoSansSC-Regular.otf", "OFL.txt"]);
  });

  it("refuses a tampered archive or one without the font", () => {
    const tampered = release([{ name: "NotoSansSC-Regular.otf", data: Buffer.from("regular") }]);
    tampered.sums.set("18_NotoSansSC.zip", "0".repeat(64));
    expect(() => placeFonts(tampered.assets, tampered.sums, tampered.out)).toThrow(/SHA256 mismatch for 18_NotoSansSC.zip/);
    const empty = release([{ name: "LICENSE", data: Buffer.from("licence") }]);
    expect(() => placeFonts(empty.assets, empty.sums, empty.out)).toThrow(/NotoSansSC-Regular.otf not found/);
    const unlisted = release([{ name: "NotoSansSC-Regular.otf", data: Buffer.from("regular") }]);
    unlisted.sums.delete("OFL.txt");
    expect(() => placeFonts(unlisted.assets, unlisted.sums, unlisted.out)).toThrow(/OFL.txt is not listed/);
  });
});
