import { describe, expect, it } from "vitest";
import { normalizeTargetLanguages } from "../../../src/server/domain/translation.ts";

describe("normalizeTargetLanguages", () => {
  it("canonicalizes each tag and drops duplicates in request order", () => {
    expect(normalizeTargetLanguages(["EN-us", "zh-hant-tw", "en-US", "ja", "JA"], "de")).toEqual({ languages: ["en-US", "zh-Hant-TW", "ja"] });
  });

  it("refuses a tag that is not BCP-47", () => {
    expect(normalizeTargetLanguages(["en", "not a tag"], "zh-CN")).toEqual({ problem: { kind: "invalid_tag", tag: "not a tag" } });
    expect(normalizeTargetLanguages(["en-US-US"], "zh-CN")).toEqual({ problem: { kind: "invalid_tag", tag: "en-US-US" } });
  });

  it("refuses a target whose primary language is the source's, whatever the region or script", () => {
    expect(normalizeTargetLanguages(["en", "zh-TW"], "zh-CN")).toEqual({ problem: { kind: "same_as_source", tag: "zh-TW" } });
    expect(normalizeTargetLanguages(["ZH"], "zh")).toEqual({ problem: { kind: "same_as_source", tag: "zh" } });
    expect(normalizeTargetLanguages(["en-GB"], "EN")).toEqual({ problem: { kind: "same_as_source", tag: "en-GB" } });
  });
});
