import { describe, expect, it } from "vitest";
import { CACHE_FILE_NAME_MAX_CHARS } from "../../../../src/shared/defaults.ts";
import { cacheMediaRequest, cachePreviewPath } from "../../../../src/web/pages/content/cache-media-dialog.tsx";

const DIR = "C:\\Users\\me\\AppData\\Roaming\\Amber\\media";

describe("cacheMediaRequest", () => {
  it("sends the height tier with a video only", () => {
    expect(cacheMediaRequest("video", 480, "第一讲")).toEqual({ type: "video", quality: 480, fileName: "第一讲" });
    expect(cacheMediaRequest("audio", 480, "第一讲")).toEqual({ type: "audio", fileName: "第一讲" });
  });
});

describe("cachePreviewPath", () => {
  it("joins the cache directory and the cleaned name with the extension of the chosen type", () => {
    expect(cachePreviewPath("第一讲", "video", "未命名内容", DIR)).toBe(`${DIR}\\第一讲.mp4`);
    expect(cachePreviewPath("第一讲", "audio", "未命名内容", `${DIR}\\`)).toBe(`${DIR}\\第一讲.mp3`);
    expect(cachePreviewPath("a/b:c.mp4", "audio", "未命名内容", "/data/media")).toBe("/data/media/abc.mp3");
  });

  it("falls back to the untitled name and shows only the file name without a directory", () => {
    expect(cachePreviewPath("  ..  ", "video", "未命名内容", undefined)).toBe("未命名内容.mp4");
    expect(cachePreviewPath("nul", "audio", "未命名内容", undefined)).toBe("nul_.mp3");
  });

  it("shortens a name the way the server does to keep the path within MAX_PATH", () => {
    const long = "讲".repeat(CACHE_FILE_NAME_MAX_CHARS + 20);
    expect(cachePreviewPath(long, "video", "未命名内容", undefined)).toBe(`${"讲".repeat(CACHE_FILE_NAME_MAX_CHARS)}.mp4`);
    const deep = `C:\\${"d".repeat(200)}`;
    const preview = cachePreviewPath(long, "video", "未命名内容", deep);
    expect(preview.length + ".partial".length - ".mp4".length + ".webm".length).toBeLessThanOrEqual(259);
    expect(preview.startsWith(`${deep}\\讲`)).toBe(true);
  });
});
