import { describe, expect, it } from "vitest";
import {
  cacheExtensionOf,
  cacheFileNameOf,
  cacheRef,
  cacheStemOf,
  fittedCacheStem,
  isCacheRef,
  isValidCacheFileName,
  numberedStem,
  sanitizeCacheStem,
  WINDOWS_MAX_PATH_UNITS,
} from "../../src/shared/cache-file-name.ts";
import { CACHE_FILE_NAME_MAX_CHARS } from "../../src/shared/defaults.ts";

describe("sanitizeCacheStem", () => {
  it("keeps readable titles and removes what Windows refuses", () => {
    expect(sanitizeCacheStem("从零开始学 Agent：第 1 讲")).toBe("从零开始学 Agent：第 1 讲");
    expect(sanitizeCacheStem("a: b")).toBe("a b");
    expect(sanitizeCacheStem('a<b>c:d"e/f\\g|h?i*j')).toBe("abcdefghij");
    expect(sanitizeCacheStem("a\u0000b\u001fc\u0085d")).toBe("abcd");
    expect(sanitizeCacheStem("  many   spaces\tand\nlines  ")).toBe("many spaces and lines");
    expect(sanitizeCacheStem("课程 #1 % 😀")).toBe("课程 #1 % 😀");
  });

  it("drops leading and trailing dots and spaces, and . / ..", () => {
    expect(sanitizeCacheStem("name. . ")).toBe("name");
    expect(sanitizeCacheStem("...hidden")).toBe("hidden");
    expect(sanitizeCacheStem(".")).toBeUndefined();
    expect(sanitizeCacheStem("..")).toBeUndefined();
    expect(sanitizeCacheStem(" ../ ")).toBeUndefined();
    expect(sanitizeCacheStem("")).toBeUndefined();
    expect(sanitizeCacheStem("\u0001\u0002")).toBeUndefined();
  });

  it("removes a media extension the user typed", () => {
    expect(sanitizeCacheStem("Lecture.MP4")).toBe("Lecture");
    expect(sanitizeCacheStem("talk.mp3")).toBe("talk");
    expect(sanitizeCacheStem("v1.2 release")).toBe("v1.2 release");
    expect(sanitizeCacheStem(".mp4")).toBe("mp4");
  });

  it("escapes device names, also before an inner dot", () => {
    expect(sanitizeCacheStem("CON")).toBe("CON_");
    expect(sanitizeCacheStem("nul")).toBe("nul_");
    expect(sanitizeCacheStem("com1")).toBe("com1_");
    expect(sanitizeCacheStem("LPT9.tar")).toBe("LPT9_.tar");
    expect(sanitizeCacheStem("console")).toBe("console");
    expect(sanitizeCacheStem("COM10")).toBe("COM10");
  });

  it("normalizes to NFC", () => {
    const decomposed = "e\u0301cole";
    expect(sanitizeCacheStem(decomposed)).toBe("\u00e9cole");
  });

  it("caps the stem in code points", () => {
    const long = "😀".repeat(CACHE_FILE_NAME_MAX_CHARS + 20);
    expect(Array.from(sanitizeCacheStem(long) ?? "")).toHaveLength(CACHE_FILE_NAME_MAX_CHARS);
  });

  it("produces only names the store accepts", () => {
    for (const input of ["CON", "a.mp4", "  x  ", "第 1 讲", "LPT1.x", "e\u0301", "a   b"]) {
      const stem = sanitizeCacheStem(input);
      expect(stem).toBeDefined();
      expect(isValidCacheFileName(`${stem}.mp4`), input).toBe(true);
    }
  });
});

describe("fittedCacheStem", () => {
  const dir = "C:\\Users\\someone\\AppData\\Roaming\\Amber\\media";

  it("keeps a short stem and appends the number", () => {
    expect(fittedCacheStem("课程", 1, dir)).toBe("课程");
    expect(fittedCacheStem("课程", 3, dir)).toBe("课程 (3)");
    expect(numberedStem("课程", 1)).toBe("课程");
    expect(numberedStem("课程", 2)).toBe("课程 (2)");
  });

  it("budgets the longest partial path in UTF-16 units", () => {
    const longDir = `C:\\${"d".repeat(200)}`;
    const stem = fittedCacheStem("😀".repeat(40), 12, longDir) as string;
    const path = `${longDir}\\${stem}.webm.partial`;
    expect(path.length).toBeLessThanOrEqual(WINDOWS_MAX_PATH_UNITS);
    expect(stem.endsWith(" (12)")).toBe(true);
    // Never splits a surrogate pair.
    expect(/[\uD800-\uDBFF]$/u.test(stem.slice(0, -" (12)".length))).toBe(false);
  });

  it("gives up when the directory alone is too long", () => {
    expect(fittedCacheStem("a", 1, `C:\\${"d".repeat(250)}`)).toBeUndefined();
  });
});

describe("cache refs", () => {
  it("builds and reads flat refs", () => {
    expect(cacheRef("a.b", "mp4")).toBe("media/a.b.mp4");
    expect(isCacheRef("media/a.mp4")).toBe(true);
    expect(isCacheRef("media/a/b.mp4")).toBe(false);
    expect(isCacheRef("assets/u/c/a")).toBe(false);
    expect(cacheFileNameOf("media/a.b.mp4")).toBe("a.b.mp4");
    expect(cacheStemOf("media/a.b.mp4")).toBe("a.b");
    expect(cacheExtensionOf("video/mp4")).toBe("mp4");
    expect(cacheExtensionOf("video/webm")).toBe("webm");
    expect(cacheExtensionOf("audio/mpeg")).toBe("mp3");
    expect(cacheExtensionOf("audio/flac")).toBeUndefined();
  });

  it("validates names", () => {
    expect(isValidCacheFileName("a.mp4")).toBe(true);
    expect(isValidCacheFileName("a.txt")).toBe(false);
    expect(isValidCacheFileName("../a.mp4")).toBe(false);
    expect(isValidCacheFileName("aux.mp3")).toBe(false);
    expect(isValidCacheFileName("a .mp4")).toBe(false);
    expect(isValidCacheFileName(`${"a".repeat(260)}.mp4`)).toBe(false);
  });
});
