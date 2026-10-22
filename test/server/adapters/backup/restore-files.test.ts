import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assignOriginalNames,
  copyFileExclusive,
  disambiguatedName,
  FileIdentityError,
  hasIdentity,
  safeOriginalName,
  sha256OfFile,
} from "../../../../src/server/adapters/backup/restore-files.ts";
import { tempDataDir } from "../../../tools/sqlite.ts";

const ID = "01J00000000000000000ABCDEF";

describe("restored original names", () => {
  it.each([
    ["lecture.mp4", "lecture.mp4"],
    ['a<b>c:d"e/f\\g|h?i*.mp4', "abcdefghi.mp4"],
    ["tab\there.mp3", "tabhere.mp3"],
    ["trailing. . ", "trailing"],
    ["CON.mp4", "_CON.mp4"],
    ["com1", "_com1"],
    ["...", ID],
    ["？问号.mp4", "？问号.mp4"],
  ])("%s → %s", (input, expected) => {
    expect(safeOriginalName(input, ID)).toBe(expected);
  });

  it("tells apart names that collide without regard to case", () => {
    const names = assignOriginalNames([
      { assetId: "01J000000000000000000AAAAA", originalName: "Lecture.mp4" },
      { assetId: "01J000000000000000000BBBBB", originalName: "lecture.MP4" },
      { assetId: "01J000000000000000000CCCCC", originalName: "other" },
    ]);
    expect([...names.values()]).toEqual(["Lecture.mp4", "lecture (0BBBBB).MP4", "other"]);
    expect(disambiguatedName("noext", ID)).toBe("noext (ABCDEF)");
  });
});

describe("copyFileExclusive", () => {
  it("copies through an exclusive partial file and leaves no partial behind", () => {
    const dir = tempDataDir("amber-copy-");
    writeFileSync(join(dir, "from"), "content");
    copyFileExclusive(join(dir, "from"), join(dir, "to"));
    expect(readFileSync(join(dir, "to"), "utf8")).toBe("content");
    expect(existsSync(join(dir, "to.partial"))).toBe(false);
    expect(hasIdentity(join(dir, "to"), 7, sha256OfFile(join(dir, "from")))).toBe(true);
    expect(hasIdentity(join(dir, "to"), 8, sha256OfFile(join(dir, "from")))).toBe(false);
  });

  it("never writes into a partial file it did not create", () => {
    const dir = tempDataDir("amber-copy-");
    writeFileSync(join(dir, "from"), "content");
    writeFileSync(join(dir, "to.partial"), "someone else's");
    expect(() => copyFileExclusive(join(dir, "from"), join(dir, "to"))).toThrow(expect.objectContaining({ code: "EEXIST" }));
    expect(readFileSync(join(dir, "to.partial"), "utf8")).toBe("someone else's");
  });

  it("notices when the written file was replaced before it got its name", () => {
    const dir = tempDataDir("amber-copy-");
    writeFileSync(join(dir, "from"), "content");
    expect(() =>
      copyFileExclusive(join(dir, "from"), join(dir, "to"), {
        beforeRename: () => {
          rmSync(join(dir, "to.partial"));
          writeFileSync(join(dir, "to.partial"), "content");
        },
      }),
    ).toThrow(FileIdentityError);
  });
});
