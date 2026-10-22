import { describe, expect, it } from "vitest";
import { MULTIPLE_LANGUAGES, trackLanguageCode, UNDETERMINED_LANGUAGE } from "../../../../src/server/domain/export/language-code.ts";

describe("trackLanguageCode", () => {
  it("maps the primary subtag of a BCP-47 tag to ISO 639-2/T", () => {
    expect(trackLanguageCode("zh-CN")).toBe("zho");
    expect(trackLanguageCode("zh-Hant-TW")).toBe("zho");
    expect(trackLanguageCode("EN")).toBe("eng");
    expect(trackLanguageCode("en_US")).toBe("eng");
    expect(trackLanguageCode("uk")).toBe("ukr");
  });

  it("is und outside the table or without a language, and the bilingual track is mul", () => {
    expect(trackLanguageCode("sw")).toBe(UNDETERMINED_LANGUAGE);
    expect(trackLanguageCode("")).toBe("und");
    expect(trackLanguageCode(undefined)).toBe("und");
    expect(MULTIPLE_LANGUAGES).toBe("mul");
  });

  it.each([
    ["en", "eng"],
    ["zh", "zho"],
    ["ja", "jpn"],
    ["ko", "kor"],
    ["fr", "fra"],
    ["de", "deu"],
    ["es", "spa"],
    ["ru", "rus"],
    ["pt", "por"],
    ["it", "ita"],
    ["ar", "ara"],
    ["hi", "hin"],
    ["vi", "vie"],
    ["th", "tha"],
    ["id", "ind"],
    ["tr", "tur"],
    ["nl", "nld"],
    ["pl", "pol"],
    ["uk", "ukr"],
  ])("maps %s to %s", (bcp47, code) => {
    expect(trackLanguageCode(bcp47)).toBe(code);
  });

  it.each(["sw", "fa", "sv", "he", "ms", "yue", "x"])("leaves %s outside the table as und", (bcp47) => {
    expect(trackLanguageCode(bcp47)).toBe("und");
  });
});
