import { describe, expect, it } from "vitest";
import { contentDisposition, exportFilename } from "../../../../src/server/domain/export/filename.ts";

describe("export file names", () => {
  it("drop path and control characters, trim, and fall back when nothing is left", () => {
    expect(exportFilename("第一讲/导论: a*b?\u0001", "未命名", "md")).toBe("第一讲导论 ab.md");
    expect(exportFilename("  \\/  ", "未命名", "srt")).toBe("未命名.srt");
    expect(exportFilename(undefined, "未命名", "ass")).toBe("未命名.ass");
  });

  it("cut the stem at 100 code points", () => {
    const name = exportFilename("😀".repeat(150), "x", "txt");
    expect([...name.slice(0, -".txt".length)]).toHaveLength(100);
  });

  it("encode the name as RFC 5987 filename*", () => {
    expect(contentDisposition("课程 (1)'s.md")).toBe("attachment; filename*=UTF-8''%E8%AF%BE%E7%A8%8B%20%281%29%27s.md");
  });
});
