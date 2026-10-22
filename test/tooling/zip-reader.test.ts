import { describe, expect, it } from "vitest";
import { readZip } from "../../src/tooling/zip-reader.ts";
import { makeZip } from "../tools/zip.ts";

describe("readZip", () => {
  it("lists entries and extracts stored and deflated data", () => {
    const text = Buffer.from("amber ".repeat(100));
    const zip = readZip(
      makeZip([
        { name: "dir/deflated.txt", data: text, method: 8 },
        { name: "stored.bin", data: Buffer.from([1, 2, 3]), method: 0 },
      ]),
    );
    expect(zip.map((entry) => entry.name)).toEqual(["dir/deflated.txt", "stored.bin"]);
    expect(zip[0]?.read()).toEqual(text);
    expect(zip[1]?.read()).toEqual(Buffer.from([1, 2, 3]));
  });

  it("rejects a corrupted entry by CRC-32", () => {
    const archive = makeZip([{ name: "a.bin", data: Buffer.from("abcdef"), method: 0 }]);
    archive[30 + "a.bin".length] = "X".charCodeAt(0);
    expect(() => readZip(archive)[0]?.read()).toThrow(/CRC-32/);
  });

  it("rejects data that is not a zip archive", () => {
    expect(() => readZip(Buffer.alloc(64))).toThrow(/not a zip archive/);
  });
});
