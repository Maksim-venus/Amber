/** BCP-47 primary language subtag of a tag, canonicalized; `undefined` for a malformed tag. */
function primarySubtag(tag: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(tag)[0]?.split("-")[0];
  } catch {
    return undefined;
  }
}

/**
 * The single `language_hints` value to send for a BCP-47 tag: its primary
 * subtag when the model documents it, else nothing, which lets the service detect the
 * language itself.
 */
export function toDashscopeLanguageHint(tag: string | undefined, supported: ReadonlySet<string>): string | undefined {
  if (tag === undefined) {
    return undefined;
  }
  const primary = primarySubtag(tag);
  return primary !== undefined && supported.has(primary) ? primary : undefined;
}

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const HANGUL = /\p{Script=Hangul}/gu;
const HAN = /\p{Script=Han}/gu;
const LATIN_WORD = /\p{Script=Latin}+/gu;
/** Frequent English function words; text made of Latin words where enough of them occur is English. */
const ENGLISH_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "the", "and", "to", "of", "a", "an", "is", "are", "in", "that", "it", "you", "i", "we", "this", "for", "on", "with", "be", "was",
]);
/** Share of Latin words that must be English function words; ordinary English prose runs well above it. */
const ENGLISH_FUNCTION_WORD_SHARE = 0.15;
/** Below this many Latin words the share says nothing. */
const ENGLISH_MIN_WORDS = 10;
/**
 * Share of the text one script must hold to name its language. Recognizers emit stray
 * lines in another script (a Japanese interjection in an English film), which must not
 * relabel the whole text.
 */
const DOMINANT_SCRIPT_SHARE = 0.6;
/** Japanese writes kana among its Han characters; Chinese text carries next to none. */
const JAPANESE_KANA_SHARE = 0.1;

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/**
 * The language of a recognized text, as far as its dominant script makes it unambiguous:
 * the result file names no language, and the hint sent with the job is not known when it
 * is read. A CJK character and a Latin word count alike. CJK text is Korean when Hangul
 * leads, Japanese when kana are frequent among its Han characters, else Chinese; Latin
 * text is English only when English function words are frequent in it. A text without a
 * dominant script, or with too little to judge, is `und`.
 */
export function inferLanguage(text: string): string {
  const kana = count(text, KANA);
  const hangul = count(text, HANGUL);
  const han = count(text, HAN);
  const words = (text.match(LATIN_WORD) ?? []).map((word) => word.toLowerCase());
  const cjk = kana + hangul + han;
  const total = cjk + words.length;
  if (total === 0) {
    return "und";
  }
  if (cjk / total >= DOMINANT_SCRIPT_SHARE) {
    if (hangul >= kana + han) {
      return "ko";
    }
    return kana / (kana + han) >= JAPANESE_KANA_SHARE ? "ja" : "zh";
  }
  if (words.length / total >= DOMINANT_SCRIPT_SHARE && words.length >= ENGLISH_MIN_WORDS) {
    const functionWords = words.filter((word) => ENGLISH_FUNCTION_WORDS.has(word)).length;
    if (functionWords / words.length >= ENGLISH_FUNCTION_WORD_SHARE) {
      return "en";
    }
  }
  return "und";
}
