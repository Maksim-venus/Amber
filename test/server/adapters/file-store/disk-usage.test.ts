import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dataDirDiskUsage } from "../../../../src/server/adapters/file-store/disk-usage.ts";
import { tempDataDir } from "../../../tools/sqlite.ts";

describe("dataDirDiskUsage", () => {
  it("sums every regular file under the data directory without following symlinks", async () => {
    const root = tempDataDir("amber-disk-");
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "one.bin"), Buffer.alloc(1000));
    writeFileSync(join(root, "a", "b", "two.bin"), Buffer.alloc(24));
    const outside = tempDataDir("amber-disk-outside-");
    writeFileSync(join(outside, "big.bin"), Buffer.alloc(50_000));
    symlinkSync(join(outside, "big.bin"), join(root, "link.bin"));

    const usage = await dataDirDiskUsage(root).diskUsage();
    expect(usage.usedBytes).toBe(1024);
    expect(usage.totalBytes).toBeGreaterThan(0);
    expect(usage.freeBytes).toBeGreaterThan(0);
    expect(usage.freeBytes).toBeLessThanOrEqual(usage.totalBytes);
  });
});
