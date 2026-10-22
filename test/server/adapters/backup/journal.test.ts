import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createJournal, readJournal, removeJournal, writeJournal, type RestoreJournalBody } from "../../../../src/server/adapters/backup/journal.ts";
import { tempDataDir } from "../../../tools/sqlite.ts";

const body: RestoreJournalBody = {
  formatVersion: 1,
  id: "01J0000000000000000000000A",
  phase: "staged",
  createdAt: 1,
  stagingDir: "01J0000000000000000000000A",
  originalsDir: null,
  previousDatabase: "pre-restore-20261019-000000",
  moves: [],
};

describe("restore journal", () => {
  it("is created exclusively, so a second restore cannot start", () => {
    const path = join(tempDataDir("amber-journal-"), "journal.json");
    createJournal(path, body);
    expect(() => createJournal(path, body)).toThrow(expect.objectContaining({ code: "EEXIST" }));
    expect(readJournal(path)).toMatchObject(body);
  });

  it("is replaced atomically and read back with its checksum", () => {
    const path = join(tempDataDir("amber-journal-"), "journal.json");
    createJournal(path, body);
    writeJournal(path, { ...body, phase: "files_moved" });
    expect(readJournal(path)).toMatchObject({ phase: "files_moved" });
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("reads as damaged when edited, torn or not JSON, and as absent when gone", () => {
    const path = join(tempDataDir("amber-journal-"), "journal.json");
    createJournal(path, body);
    const text = readFileSync(path, "utf8");
    writeFileSync(path, text.replace('"staged"', '"committed"'));
    expect(readJournal(path)).toBe("damaged");
    writeFileSync(path, text.slice(0, text.length / 2));
    expect(readJournal(path)).toBe("damaged");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(text), formatVersion: 2 }));
    expect(readJournal(path)).toBe("damaged");
    removeJournal(path);
    expect(readJournal(path)).toBeUndefined();
  });
});
