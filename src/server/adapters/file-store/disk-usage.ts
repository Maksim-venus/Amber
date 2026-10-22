import { lstat, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { FileStore } from "../../ports/file-store.ts";

/**
 * Disk usage of the data directory for the low-water mark: `usedBytes` is
 * every regular file under it, symlinks not followed; free and total space come from the
 * volume that holds it.
 */
export function dataDirDiskUsage(root: string): Pick<FileStore, "diskUsage"> {
  return {
    async diskUsage() {
      const volume = await statfs(root);
      return {
        usedBytes: await directoryBytes(root),
        freeBytes: volume.bavail * volume.bsize,
        totalBytes: volume.blocks * volume.bsize,
      };
    },
  };
}

async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directoryBytes(path);
    } else if (entry.isFile()) {
      // A file removed between listing and stat simply no longer counts.
      total += await lstat(path).then(
        (stats) => stats.size,
        () => 0,
      );
    }
  }
  return total;
}
