import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CACHE_ROOT_MARKER,
  CACHE_ROOT_MARKER_MAGIC,
  CACHE_ROOTS_FILE,
  CACHE_SCRATCH_DIR,
  DATA_ROOT_MARKER,
  DATA_ROOT_MARKER_MAGIC,
  LEGACY_APP_IDENTIFIER,
  markerText,
} from "../../src/shared/app-identity.ts";
import { parseCacheRoots, removeOwnedRoot, removeStateDir, renderReport, uninstallData } from "../../src/server/uninstall-data.ts";

const SCRIPT = join(import.meta.dirname, "..", "..", "src", "server", "uninstall-data.ts");

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "amber-uninstall-"));
}

/** A UTF-16LE registry with a byte order mark and CRLF line ends, as the sidecar writes it. */
function registry(paths: readonly string[]): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(paths.map((path) => `${path}\r\n`).join(""), "utf16le")]);
}

function dataDir(base: string, cacheRoots: readonly string[] = []): string {
  const dir = join(base, "Amber");
  mkdirSync(join(dir, "media"), { recursive: true });
  mkdirSync(join(dir, "logs"), { recursive: true });
  writeFileSync(join(dir, DATA_ROOT_MARKER), markerText(DATA_ROOT_MARKER_MAGIC));
  writeFileSync(join(dir, "amber.db"), "db");
  writeFileSync(join(dir, "media", "第 1 讲 #双语.mp4"), "video");
  mkdirSync(join(dir, "media", CACHE_SCRATCH_DIR, "01ASSET", "01RUN"), { recursive: true });
  writeFileSync(join(dir, "media", CACHE_SCRATCH_DIR, "01ASSET", "01RUN", "video.f30080.mp4"), "stream");
  writeFileSync(join(dir, "logs", "shell.log"), "log");
  writeFileSync(join(dir, CACHE_ROOTS_FILE), registry(cacheRoots));
  return dir;
}

function cacheRoot(base: string, name: string): string {
  const dir = join(base, name, "media");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, CACHE_ROOT_MARKER), markerText(CACHE_ROOT_MARKER_MAGIC));
  writeFileSync(join(dir, "改过名的.mp4"), "renamed");
  // An interrupted video download's intermediate files.
  mkdirSync(join(dir, CACHE_SCRATCH_DIR, "01ASSET", "01RUN"), { recursive: true });
  writeFileSync(join(dir, CACHE_SCRATCH_DIR, "01ASSET", "01RUN", "video.f30280.m4a"), "stream");
  return dir;
}

describe("parseCacheRoots", () => {
  it("reads UTF-16LE with or without a byte order mark, skipping blank and repeated lines", () => {
    expect(parseCacheRoots(registry(["D:\\视频\\media", "E:\\x\\media", "D:\\视频\\media"]))).toEqual(["D:\\视频\\media", "E:\\x\\media"]);
    expect(parseCacheRoots(Buffer.from("D:\\a\\media\n\r\nE:\\b\\media", "utf16le"))).toEqual(["D:\\a\\media", "E:\\b\\media"]);
    expect(parseCacheRoots(Buffer.alloc(0))).toEqual([]);
  });
});

describe("renderReport", () => {
  it("writes UTF-16LE with a byte order mark and one CRLF-terminated line per root", () => {
    const bytes = renderReport([
      { status: "OK", path: "D:\\视频\\media" },
      { status: "MISSING", path: "E:\\media" },
    ]);
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(bytes.subarray(2).toString("utf16le")).toBe("OK D:\\视频\\media\r\nMISSING E:\\media\r\n");
  });
});

describe("removeOwnedRoot", () => {
  it("refuses a directory without a valid marker and leaves it untouched", () => {
    const base = scratch();
    const dir = join(base, "media");
    mkdirSync(dir);
    writeFileSync(join(dir, "mine.mp4"), "x");
    expect(removeOwnedRoot(dir, CACHE_ROOT_MARKER, CACHE_ROOT_MARKER_MAGIC)).toBe("REFUSED");
    // The data directory marker does not make a directory a cache root, nor the other way round.
    writeFileSync(join(dir, CACHE_ROOT_MARKER), markerText(DATA_ROOT_MARKER_MAGIC));
    expect(removeOwnedRoot(dir, CACHE_ROOT_MARKER, CACHE_ROOT_MARKER_MAGIC)).toBe("REFUSED");
    expect(readFileSync(join(dir, "mine.mp4"), "utf8")).toBe("x");
  });

  it("removes a root marked by a build under the legacy identifier", () => {
    const base = scratch();
    const dir = cacheRoot(base, "legacy");
    writeFileSync(join(dir, CACHE_ROOT_MARKER), `${CACHE_ROOT_MARKER_MAGIC}\r\n${LEGACY_APP_IDENTIFIER}\r\n`);
    expect(removeOwnedRoot(dir, CACHE_ROOT_MARKER, CACHE_ROOT_MARKER_MAGIC)).toBe("OK");
    expect(existsSync(dir)).toBe(false);
  });

  it("refuses a root that is a symbolic link, even to a marked directory", () => {
    const base = scratch();
    const real = cacheRoot(base, "real");
    const link = join(base, "link");
    symlinkSync(real, link, "dir");
    expect(removeOwnedRoot(link, CACHE_ROOT_MARKER, CACHE_ROOT_MARKER_MAGIC)).toBe("REFUSED");
    expect(existsSync(join(real, "改过名的.mp4"))).toBe(true);
  });

  it("removes links inside a root without touching what they point to", () => {
    const base = scratch();
    const root = cacheRoot(base, "owned");
    const outside = join(base, "outside");
    mkdirSync(join(outside, "deep"), { recursive: true });
    writeFileSync(join(outside, "keep.txt"), "keep");
    writeFileSync(join(outside, "deep", "keep.mp4"), "keep");
    symlinkSync(outside, join(root, "junction-like"), "dir");
    symlinkSync(join(outside, "keep.txt"), join(root, "file-link.txt"), "file");
    mkdirSync(join(root, "sub"));
    symlinkSync(outside, join(root, "sub", "nested-link"), "dir");

    expect(removeOwnedRoot(root, CACHE_ROOT_MARKER, CACHE_ROOT_MARKER_MAGIC)).toBe("OK");
    expect(existsSync(root)).toBe(false);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(readFileSync(join(outside, "deep", "keep.mp4"), "utf8")).toBe("keep");
  });

  it("reports a missing root and refuses a relative one", () => {
    const base = scratch();
    expect(removeOwnedRoot(join(base, "offline", "media"), CACHE_ROOT_MARKER, CACHE_ROOT_MARKER_MAGIC)).toBe("MISSING");
    expect(removeOwnedRoot("media", CACHE_ROOT_MARKER, CACHE_ROOT_MARKER_MAGIC)).toBe("REFUSED");
  });
});

describe("uninstallData", () => {
  it("removes the registered cache roots and then the data directory", () => {
    const base = scratch();
    const first = cacheRoot(base, "one");
    const second = cacheRoot(base, "two");
    const data = dataDir(base, [first, second]);
    const result = uninstallData(data);
    expect(result).toEqual({
      outcomes: [
        { status: "OK", path: first },
        { status: "OK", path: second },
        { status: "OK", path: data },
      ],
      exitCode: 0,
    });
    for (const dir of [first, second, data]) {
      expect(existsSync(dir)).toBe(false);
    }
    // Only the `media` directory and its marker go; the folder the user picked stays.
    expect(existsSync(join(base, "one"))).toBe(true);
  });

  it("reports an offline cache root and a foreign one, still removing the data directory", () => {
    const base = scratch();
    const offline = join(base, "unplugged", "media");
    const foreign = join(base, "foreign", "media");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "keep.mp4"), "keep");
    const data = dataDir(base, [offline, foreign]);
    const result = uninstallData(data);
    expect(result.outcomes).toEqual([
      { status: "MISSING", path: offline },
      { status: "REFUSED", path: foreign },
      { status: "OK", path: data },
    ]);
    expect(result.exitCode).toBe(2);
    expect(readFileSync(join(foreign, "keep.mp4"), "utf8")).toBe("keep");
  });

  it("works without a registry and refuses an unmarked data directory", () => {
    const base = scratch();
    const data = dataDir(base);
    const unmarked = join(base, "Other");
    mkdirSync(unmarked);
    writeFileSync(join(unmarked, "notes.txt"), "mine");
    expect(uninstallData(unmarked)).toEqual({ outcomes: [{ status: "REFUSED", path: unmarked }], exitCode: 2 });
    expect(readFileSync(join(unmarked, "notes.txt"), "utf8")).toBe("mine");
    expect(uninstallData(join(base, "Never"))).toEqual({ outcomes: [{ status: "MISSING", path: join(base, "Never") }], exitCode: 2 });
    unlinkSync(join(data, CACHE_ROOTS_FILE));
    expect(uninstallData(data).outcomes).toEqual([{ status: "OK", path: data }]);
  });

  it("keeps the data directory when the registry cannot be read", () => {
    // A directory where the registry file should be cannot be read as one.
    const unreadable = dataDir(scratch());
    const registryPath = join(unreadable, CACHE_ROOTS_FILE);
    unlinkSync(registryPath);
    mkdirSync(registryPath);
    expect(uninstallData(unreadable)).toEqual({ outcomes: [{ status: "LEFT", path: unreadable }], exitCode: 2 });
    expect(existsSync(join(unreadable, "amber.db"))).toBe(true);
  });
});

describe("uninstall-data.js", () => {
  it("runs as a script, writes the report and exits 0 when everything is gone", () => {
    const base = scratch();
    const root = cacheRoot(base, "one");
    const data = dataDir(base, [root]);
    const report = join(base, "report.txt");
    const run = spawnSync(process.execPath, [SCRIPT, data, report], { encoding: "utf8" });
    expect(run.status).toBe(0);
    const bytes = readFileSync(report);
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(bytes.subarray(2).toString("utf16le")).toBe(`OK ${root}\r\nOK ${data}\r\n`);
  });

  it("exits 2 when something is left and without arguments", () => {
    const base = scratch();
    const report = join(base, "report.txt");
    expect(spawnSync(process.execPath, [SCRIPT, join(base, "Missing"), report]).status).toBe(2);
    expect(readFileSync(report).subarray(2).toString("utf16le")).toBe(`MISSING ${join(base, "Missing")}\r\n`);
    expect(spawnSync(process.execPath, [SCRIPT]).status).toBe(2);
  });
});

describe("removeStateDir", () => {
  it("removes the legacy WebView2 state directory, and reports a missing one as missing", () => {
    const base = scratch();
    const dir = join(base, LEGACY_APP_IDENTIFIER);
    mkdirSync(join(dir, "EBWebView", "Default"), { recursive: true });
    writeFileSync(join(dir, "EBWebView", "Default", "Cookies"), "x");
    expect(removeStateDir(dir)).toBe("OK");
    expect(existsSync(dir)).toBe(false);
    expect(removeStateDir(dir)).toBe("MISSING");
    expect(removeStateDir("relative")).toBe("REFUSED");
  });

  it("refuses a link and leaves what it points to", () => {
    const base = scratch();
    const real = join(base, "real");
    mkdirSync(real);
    writeFileSync(join(real, "keep.txt"), "x");
    const link = join(base, LEGACY_APP_IDENTIFIER);
    symlinkSync(real, link, "dir");
    expect(removeStateDir(link)).toBe("REFUSED");
    expect(readFileSync(join(real, "keep.txt"), "utf8")).toBe("x");
  });
});

describe("uninstallData with a legacy state directory", () => {
  it("removes it first, so the data directory's line stays last", () => {
    const base = scratch();
    const data = dataDir(base);
    const legacy = join(base, LEGACY_APP_IDENTIFIER);
    mkdirSync(join(legacy, "EBWebView"), { recursive: true });
    const result = uninstallData(data, legacy);
    expect(result.outcomes).toEqual([
      { status: "OK", path: legacy },
      { status: "OK", path: data },
    ]);
    expect(result.exitCode).toBe(0);
  });

  it("does not report one that is not there", () => {
    const base = scratch();
    const data = dataDir(base);
    expect(uninstallData(data, join(base, LEGACY_APP_IDENTIFIER)).outcomes).toEqual([{ status: "OK", path: data }]);
  });
});
