import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readBackupHeader, unpackBackup } from "../../../../src/server/adapters/backup/archive-reader.ts";
import { archiveEntries, buildSourceLibrary, exportParts, rawTar } from "../../../fixtures/backup/build-backup.ts";
import { tempDataDir } from "../../../tools/sqlite.ts";

describe("archive reader", () => {
  it("unpacks a well-formed backup into staging and verifies every file", async () => {
    const parts = exportParts(await buildSourceLibrary(), { includeOriginals: true, includeCache: true });
    const archive = join(tempDataDir("amber-archive-"), "a.amberbackup");
    writeFileSync(archive, rawTar(archiveEntries(parts)));
    expect(readBackupHeader(archive)).toEqual(parts.header);
    const staging = tempDataDir("amber-staging-");
    const seen: number[] = [];
    const unpacked = unpackBackup(archive, staging, { onFile: ({ files }) => seen.push(files) });
    expect([...unpacked.files.keys()].sort()).toEqual(["database.sqlite", ...parts.files.keys()].sort());
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(readdirSync(staging).sort()).toEqual(["database.sqlite", "media", "originals"]);
  });

  it("accepts directory entries for the two archive directories only", async () => {
    const parts = exportParts(await buildSourceLibrary({ originalNames: ["a.mp4"], cacheNames: [] }), { includeOriginals: true, includeCache: false });
    const entries = archiveEntries(parts);
    const withDirs = [entries[0], entries[1], { path: "originals/", type: "Directory" as const }, ...entries.slice(2)].filter((entry) => entry !== undefined);
    const archive = join(tempDataDir("amber-archive-"), "a.amberbackup");
    writeFileSync(archive, rawTar(withDirs));
    expect(unpackBackup(archive, tempDataDir("amber-staging-")).files.size).toBe(2);
    writeFileSync(archive, rawTar([...withDirs.slice(0, 2), { path: "elsewhere/", type: "Directory" }, ...withDirs.slice(2)]));
    expect(() => unpackBackup(archive, tempDataDir("amber-staging-"))).toThrow(expect.objectContaining({ appError: expect.objectContaining({ code: "backup_invalid" }) }));
  });
});
