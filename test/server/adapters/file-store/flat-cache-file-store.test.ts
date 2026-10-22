import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FlatCacheFileStore } from "../../../../src/server/adapters/file-store/flat-cache-file-store.ts";
import { tempDataDir } from "../../../tools/sqlite.ts";

function setup(createDir = true) {
  const parent = tempDataDir("amber-flat-cache-");
  const dir = join(parent, "media");
  return { parent, dir, store: new FlatCacheFileStore(dir, { createDir }) };
}

describe("FlatCacheFileStore", () => {
  it("maps media/<name> to <dir>/<name> and accepts readable Unicode names", async () => {
    const { dir, store } = setup();
    expect(store.pathOf("media/从零开始学 Agent 第 1 讲 (2).mp4")).toBe(join(dir, "从零开始学 Agent 第 1 讲 (2).mp4"));
    const stored = await store.writeAtomic("media/课程 #1 😀.mp3", Buffer.from("abc"));
    expect(stored.sizeBytes).toBe(3);
    expect(await store.stat("media/课程 #1 😀.mp3")).toEqual({ sizeBytes: 3 });
    expect(await store.digest("media/课程 #1 😀.mp3")).toBe(stored.digest);
    expect(existsSync(join(dir, "课程 #1 😀.mp3.partial"))).toBe(false);
  });

  it("refuses refs that could leave the directory or are not cache names", () => {
    const { store } = setup();
    for (const ref of [
      "media/../x.mp4",
      "media/..",
      "media/a/b.mp4",
      "media/a\\b.mp4",
      "media/C:x.mp4",
      "media/CON.mp4",
      "media/nul.mp3",
      "media/a.exe",
      "media/a. .mp4",
      "media/.mp4",
      "assets/u/c/a",
      "a.mp4",
      "media/a\u0000.mp4",
      "media/ a.mp4",
    ]) {
      expect(() => store.pathOf(ref), ref).toThrow(TypeError);
    }
  });

  it("lists, measures and cleans only the top level of its own directory", async () => {
    const { parent, dir, store } = setup();
    await store.writeAtomic("media/a.mp4", Buffer.from("12345"));
    await store.writeAtomic("media/b.mp3", Buffer.from("12"));
    writeFileSync(join(dir, ".amber-cache-root"), "marker");
    writeFileSync(join(dir, "user notes.txt"), "keep");
    writeFileSync(join(dir, "c.mp4.partial"), "debris");
    writeFileSync(join(dir, "not ours.partial"), "keep");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "d.mp4.partial"), "keep");
    writeFileSync(join(parent, "e.mp4.partial"), "keep");
    expect(await store.list("media")).toEqual(["media/a.mp4", "media/b.mp3"]);
    expect(await store.list("assets")).toEqual([]);
    expect(await store.usedBytes("media")).toBe(7);
    expect(await store.removePartials()).toBe(1);
    expect(existsSync(join(dir, "c.mp4.partial"))).toBe(false);
    for (const kept of [join(dir, "not ours.partial"), join(dir, "sub", "d.mp4.partial"), join(parent, "e.mp4.partial"), join(dir, "user notes.txt")]) {
      expect(existsSync(kept), kept).toBe(true);
    }
    expect(await store.removeEmptyDirs()).toBe(0);
    expect(existsSync(join(dir, "sub"))).toBe(true);
    expect((await store.diskUsage()).usedBytes).toBe(7);
  });

  it("removes single files only, never the directory", async () => {
    const { dir, store } = setup();
    await store.writeAtomic("media/a.mp4", Buffer.from("x"));
    await store.remove("media/a.mp4");
    await store.remove("media/missing.mp4");
    expect(existsSync(join(dir, "a.mp4"))).toBe(false);
    await expect(store.remove("media")).rejects.toThrow(TypeError);
    expect(existsSync(dir)).toBe(true);
  });

  it("does not list a link that points elsewhere as a cache file", async () => {
    const { parent, dir, store } = setup();
    await store.writeAtomic("media/a.mp4", Buffer.from("x"));
    mkdirSync(join(parent, "elsewhere"));
    symlinkSync(join(parent, "elsewhere"), join(dir, "link.mp4"));
    expect(await store.list("media")).toEqual(["media/a.mp4"]);
  });

  it("never creates a directory it was not told to create", async () => {
    const { dir, store } = setup(false);
    expect(await store.list("media")).toEqual([]);
    await expect(store.writeAtomic("media/a.mp4", Buffer.from("x"))).rejects.toThrow();
    expect(existsSync(dir)).toBe(false);
  });
});
