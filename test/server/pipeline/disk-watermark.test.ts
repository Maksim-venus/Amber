import { describe, expect, it } from "vitest";
import { belowWatermark, diskLowAfterWriting, diskLowError } from "../../../src/server/pipeline/disk-watermark.ts";

const GB = 1024 ** 3;
const settings = { maxDataGB: 30, lowWaterFreeGB: 10, lowWaterFreeRatio: 0.2 };

describe("disk low-water mark", () => {
  it("trips on data size, absolute free space or free ratio", () => {
    expect(belowWatermark({ usedBytes: 1 * GB, freeBytes: 500 * GB, totalBytes: 1000 * GB }, settings)).toBe(false);
    expect(belowWatermark({ usedBytes: 31 * GB, freeBytes: 500 * GB, totalBytes: 1000 * GB }, settings)).toBe(true);
    expect(belowWatermark({ usedBytes: 1 * GB, freeBytes: 9 * GB, totalBytes: 20 * GB }, settings)).toBe(true);
    expect(belowWatermark({ usedBytes: 1 * GB, freeBytes: 150 * GB, totalBytes: 1000 * GB }, settings)).toBe(true);
  });

  it("reports disk_low as a never-retried error", async () => {
    const probe = { diskUsage: async () => ({ usedBytes: 0, freeBytes: 0, totalBytes: 1 }) };
    const full = { ...settings, concurrencyPipeline: 1, uploadRetentionDefault: "keep" as const, updatedAt: 0 };
    expect(await diskLowError(probe, full)).toMatchObject({ class: "disk_low", retryDisposition: "never" });
  });

  it("counts a planned output against free space", async () => {
    const full = { ...settings, concurrencyPipeline: 1, uploadRetentionDefault: "keep" as const, updatedAt: 0 };
    const probe = { diskUsage: async () => ({ usedBytes: 1 * GB, freeBytes: 500 * GB, totalBytes: 1000 * GB }) };
    // 200 GB is the ratio mark of a 1000 GB volume: 300 GB may be written, a byte more may not.
    expect(await diskLowAfterWriting(probe, full, 300 * GB)).toBeUndefined();
    expect(await diskLowAfterWriting(probe, full, 300 * GB + 1)).toMatchObject({ class: "disk_low" });
  });
});
