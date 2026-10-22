/**
 * Display names of the output languages offered as quick choices; any valid BCP-47
 * tag is still accepted. Keyed by tag; a primary subtag stands for its whole language.
 */
export const languageNames: Readonly<Record<string, string>> = {
  "zh-CN": "简体中文",
  "zh-TW": "繁体中文",
  zh: "中文",
  en: "英语",
  ja: "日语",
  ko: "韩语",
  fr: "法语",
  de: "德语",
  es: "西班牙语",
  pt: "葡萄牙语",
  ru: "俄语",
  it: "意大利语",
};
