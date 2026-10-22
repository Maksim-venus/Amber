import { appError } from "../domain/errors.ts";
import type { InstanceSettings } from "../domain/runtime-support.ts";
import type { FileStore } from "../ports/file-store.ts";
import type { AppError } from "../../shared/errors.ts";
import { BYTES_PER_GB } from "../../shared/units.ts";

export type DiskUsageProbe = Pick<FileStore, "diskUsage">;
type DiskUsage = Awaited<ReturnType<FileStore["diskUsage"]>>;

/**
 * The low-water mark: the data directory exceeds `maxDataGB`, or free space
 * drops below `lowWaterFreeGB` or below `lowWaterFreeRatio` of the volume.
 */
export function belowWatermark(usage: DiskUsage, settings: Pick<InstanceSettings, "maxDataGB" | "lowWaterFreeGB" | "lowWaterFreeRatio">): boolean {
  return (
    usage.usedBytes > settings.maxDataGB * BYTES_PER_GB ||
    usage.freeBytes < settings.lowWaterFreeGB * BYTES_PER_GB ||
    (usage.totalBytes > 0 && usage.freeBytes / usage.totalBytes < settings.lowWaterFreeRatio)
  );
}

/** `disk_low` when new work must not start; running work is never interrupted by this check. */
export async function diskLowError(probe: DiskUsageProbe, settings: InstanceSettings): Promise<AppError | undefined> {
  return belowWatermark(await probe.diskUsage(), settings) ? appError("disk_low") : undefined;
}

/**
 * `disk_low` when the volume is below the low-water mark now, or would be once `plannedBytes`
 * more are written to it — the check a known-size output gets before it starts.
 */
export async function diskLowAfterWriting(probe: DiskUsageProbe, settings: InstanceSettings, plannedBytes: number): Promise<AppError | undefined> {
  const usage = await probe.diskUsage();
  return belowWatermark(usage, settings) || belowWatermark({ ...usage, freeBytes: usage.freeBytes - plannedBytes }, settings) ? appError("disk_low") : undefined;
}
