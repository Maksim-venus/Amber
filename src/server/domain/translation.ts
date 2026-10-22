/** Why a set of requested target languages cannot be translated. */
export type TargetLanguageProblem = { kind: "invalid_tag"; tag: string } | { kind: "same_as_source"; tag: string };

/**
 * The target languages of a translation: each tag canonicalized as BCP-47
 * (`Intl.getCanonicalLocales`), duplicates dropped in request order. A tag whose primary
 * language subtag equals the source's is refused, so `zh-TW` is not a translation of `zh-CN`.
 */
export function normalizeTargetLanguages(
  requested: readonly string[],
  sourceLanguage: string,
): { languages: string[] } | { problem: TargetLanguageProblem } {
  const source = primarySubtag(sourceLanguage);
  const languages: string[] = [];
  for (const tag of requested) {
    let canonical: string;
    try {
      [canonical = tag] = Intl.getCanonicalLocales(tag);
    } catch {
      return { problem: { kind: "invalid_tag", tag } };
    }
    if (primarySubtag(canonical) === source) {
      return { problem: { kind: "same_as_source", tag: canonical } };
    }
    if (!languages.includes(canonical)) {
      languages.push(canonical);
    }
  }
  return { languages };
}

function primarySubtag(tag: string): string {
  return (tag.split("-")[0] ?? "").toLowerCase();
}
