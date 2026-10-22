import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDataDir } from "../../../../src/server/adapters/file-store/data-dir.ts";
import { tempDataDir } from "../../../tools/sqlite.ts";

describe("ensureDataDir", () => {
  it("creates backups/ and secrets/ as private directories, and tightens them again on the next start", () => {
    const root = join(tempDataDir("amber-data-"), "nested", "data");
    const layout = ensureDataDir(root);
    expect(layout).toEqual({
      root,
      database: join(root, "amber.db"),
      backups: join(root, "backups"),
      secrets: join(root, "secrets"),
    });
    if (process.platform === "win32") return;
    expect(statSync(layout.backups).mode & 0o777).toBe(0o700);
    expect(statSync(layout.secrets).mode & 0o777).toBe(0o700);
    chmodSync(layout.secrets, 0o755);
    ensureDataDir(root);
    expect(statSync(layout.secrets).mode & 0o777).toBe(0o700);
  });
});
