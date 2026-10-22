import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CacheRootsRegistry, parseCacheRoots, serializeCacheRoots } from "../../../src/server/application/cache-roots-registry.ts";
import { CACHE_ROOTS_FILE } from "../../../src/shared/app-identity.ts";
import { tempDataDir } from "../../tools/sqlite.ts";

function registry(options: { isWindows?: boolean } = {}): { registry: CacheRootsRegistry; file: string; dir: string } {
  const dir = tempDataDir("amber-cache-roots-");
  const file = join(dir, CACHE_ROOTS_FILE);
  return { registry: new CacheRootsRegistry(file, options), file, dir };
}

describe("cache roots registry format", () => {
  it("is UTF-16LE with a byte order mark and a CRLF after every path, readable back", () => {
    const paths = ["D:\\课程\\media", "E:\\#1 50%\\media"];
    const bytes = serializeCacheRoots(paths);
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(bytes.subarray(2).toString("utf16le")).toBe("D:\\课程\\media\r\nE:\\#1 50%\\media\r\n");
    expect(parseCacheRoots(bytes)).toEqual(paths);
    expect([...serializeCacheRoots([])]).toEqual([0xff, 0xfe]);
  });

  it("refuses bytes it did not write instead of reading them as empty", () => {
    expect(() => parseCacheRoots(Buffer.from("D:\\media\r\n", "utf8"))).toThrow();
    expect(() => parseCacheRoots(Buffer.alloc(0))).toThrow();
  });
});

describe("CacheRootsRegistry", () => {
  it("lists nothing before the first registration, then adds once and removes, replacing the file atomically", async () => {
    const { registry: roots, file, dir } = registry();
    expect(await roots.list()).toEqual([]);
    await roots.add("/mnt/a/media");
    await roots.add("/mnt/b/media");
    await roots.add("/mnt/a/media");
    expect(await roots.list()).toEqual(["/mnt/a/media", "/mnt/b/media"]);
    expect(readFileSync(file)).toEqual(serializeCacheRoots(["/mnt/a/media", "/mnt/b/media"]));
    await roots.remove("/mnt/a/media");
    await roots.remove("/mnt/never/media");
    expect(await roots.list()).toEqual(["/mnt/b/media"]);
    // No temp file is left beside it.
    expect(readdirSync(dir)).toEqual([CACHE_ROOTS_FILE]);
  });

  it("compares paths case-insensitively on Windows only", async () => {
    const windows = registry({ isWindows: true }).registry;
    await windows.add("D:\\Videos\\media");
    await windows.add("d:\\videos\\MEDIA");
    expect(await windows.list()).toEqual(["D:\\Videos\\media"]);
    await windows.remove("D:\\VIDEOS\\media");
    expect(await windows.list()).toEqual([]);

    const posix = registry({ isWindows: false }).registry;
    await posix.add("/a/media");
    await posix.add("/A/media");
    expect(await posix.list()).toEqual(["/a/media", "/A/media"]);
  });

  it("serializes concurrent updates so none is lost", async () => {
    const { registry: roots } = registry();
    await Promise.all(Array.from({ length: 8 }, (_, i) => roots.add(`/mnt/${i}/media`)));
    expect((await roots.list()).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `/mnt/${i}/media`).sort());
  });

  it("never overwrites a file it cannot read", async () => {
    const { registry: roots, file } = registry();
    writeFileSync(file, "not ours");
    await expect(roots.add("/mnt/a/media")).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe("not ours");
    expect(existsSync(`${file}.tmp`)).toBe(false);
    // A failed call does not block the next one.
    writeFileSync(file, serializeCacheRoots([]));
    await roots.add("/mnt/a/media");
    expect(await roots.list()).toEqual(["/mnt/a/media"]);
  });
});
