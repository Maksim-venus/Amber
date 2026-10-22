/**
 * Languages Scribe documents as supported, by ISO 639-3 code. `language_code` accepts
 * ISO 639-1 or 639-3; the 639-3 form is sent because it is what the documentation lists.
 */
const SUPPORTED_ISO639_3: readonly string[] = [
  "afr", "amh", "ara", "hye", "asm", "ast", "aze", "bel", "ben", "bos", "bul", "mya", "yue", "cat", "ceb", "nya",
  "hrv", "ces", "dan", "nld", "eng", "est", "fil", "fin", "fra", "ful", "glg", "lug", "kat", "deu", "ell", "guj",
  "hau", "heb", "hin", "hun", "isl", "ibo", "ind", "gle", "ita", "jpn", "jav", "kea", "kan", "kaz", "khm", "kor",
  "kur", "kir", "lao", "lav", "lin", "lit", "luo", "ltz", "mkd", "msa", "mal", "mlt", "zho", "mri", "mar", "mon",
  "nep", "nso", "nor", "oci", "ori", "pus", "fas", "pol", "por", "pan", "ron", "rus", "srp", "sna", "snd", "sin",
  "slk", "slv", "som", "spa", "swa", "swe", "tam", "tgk", "tel", "tha", "tur", "ukr", "umb", "urd", "uzb", "vie",
  "cym", "wol", "xho", "zul",
];

/** Primary subtags whose canonical form is not the one the supported code canonicalizes to. */
const ALIASES: Readonly<Record<string, string>> = { nb: "nor", nn: "nor", tl: "fil" };

/** Canonical BCP-47 primary language subtag → supported ISO 639-3 code. */
const BY_PRIMARY: ReadonlyMap<string, string> = new Map([
  ...SUPPORTED_ISO639_3.map((code) => [primarySubtag(code) ?? code, code] as const),
  ...Object.entries(ALIASES),
]);

function primarySubtag(tag: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(tag)[0]?.split("-")[0];
  } catch {
    return undefined;
  }
}

/**
 * The `language_code` to send for a BCP-47 tag: its primary language subtag
 * mapped to a supported ISO 639-3 code. Anything that does not map is not sent, which lets
 * the service detect the language itself.
 */
export function toElevenLabsLanguage(tag: string | undefined): string | undefined {
  if (tag === undefined) {
    return undefined;
  }
  const primary = primarySubtag(tag);
  return primary === undefined ? undefined : BY_PRIMARY.get(primary);
}

/** The detected language (`eng`, `zho`, sometimes `en`) as a canonical BCP-47 tag, or `und`. */
export function fromElevenLabsLanguage(code: string): string {
  try {
    return Intl.getCanonicalLocales(code.trim())[0] ?? "und";
  } catch {
    return "und";
  }
}
