/**
 * BCP-47 primary subtags and their ISO 639-2/T codes. Subtitle tracks are
 * tagged with the three-letter code because MP4 drops BCP-47 tags such as `zh-CN`.
 */
const ISO_639_2T: Readonly<Record<string, string>> = {
  en: "eng",
  zh: "zho",
  ja: "jpn",
  ko: "kor",
  fr: "fra",
  de: "deu",
  es: "spa",
  ru: "rus",
  pt: "por",
  it: "ita",
  ar: "ara",
  hi: "hin",
  vi: "vie",
  th: "tha",
  id: "ind",
  tr: "tur",
  nl: "nld",
  pl: "pol",
  uk: "ukr",
};

/** The language of a track carrying more than one language: the bilingual track. */
export const MULTIPLE_LANGUAGES = "mul";
/** A language outside the table, or none at all. */
export const UNDETERMINED_LANGUAGE = "und";

/** The ISO 639-2/T code of a BCP-47 tag by its primary subtag; `und` outside the table. */
export function trackLanguageCode(bcp47: string | undefined): string {
  const primary = bcp47?.split(/[-_]/u)[0]?.toLowerCase();
  return (primary === undefined ? undefined : ISO_639_2T[primary]) ?? UNDETERMINED_LANGUAGE;
}
