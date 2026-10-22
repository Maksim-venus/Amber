import { describe, expect, it } from "vitest";
import { fromElevenLabsLanguage, toElevenLabsLanguage } from "../../../../../src/server/adapters/asr/elevenlabs/language.ts";

describe("toElevenLabsLanguage", () => {
  it("maps the primary language subtag of a BCP-47 tag to a supported ISO 639-3 code", () => {
    expect(toElevenLabsLanguage("zh")).toBe("zho");
    expect(toElevenLabsLanguage("zh-Hans-CN")).toBe("zho");
    expect(toElevenLabsLanguage("cmn")).toBe("zho");
    expect(toElevenLabsLanguage("en-US")).toBe("eng");
    expect(toElevenLabsLanguage("ja")).toBe("jpn");
    expect(toElevenLabsLanguage("yue")).toBe("yue");
    expect(toElevenLabsLanguage("nb")).toBe("nor");
    expect(toElevenLabsLanguage("eng")).toBe("eng");
  });

  it("sends nothing for an absent, undetermined, unsupported or malformed tag", () => {
    for (const tag of [undefined, "und", "tlh", "", "not a tag", "x-private"]) {
      expect(toElevenLabsLanguage(tag)).toBeUndefined();
    }
  });
});

describe("fromElevenLabsLanguage", () => {
  it("turns the detected code into a canonical BCP-47 tag", () => {
    expect(fromElevenLabsLanguage("eng")).toBe("en");
    expect(fromElevenLabsLanguage("zho")).toBe("zh");
    expect(fromElevenLabsLanguage("cmn")).toBe("zh");
    expect(fromElevenLabsLanguage("en")).toBe("en");
    expect(fromElevenLabsLanguage("yue")).toBe("yue");
  });

  it("falls back to und for what is not a language tag", () => {
    expect(fromElevenLabsLanguage("")).toBe("und");
    expect(fromElevenLabsLanguage("??")).toBe("und");
  });
});
