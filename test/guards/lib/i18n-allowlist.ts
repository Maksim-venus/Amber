/**
 * Exceptions to the hardcoded-copy guard. Each entry names one literal in one file and why it is not
 * user-facing copy; keep the list short and give every entry a reason a reviewer can check.
 */
export interface I18nAllowlistEntry {
  /** Repository-relative path with forward slashes. */
  file: string;
  /** The literal's text exactly as written (for JSX text: trimmed). */
  text: string;
  reason: string;
}

export const I18N_ALLOWLIST: readonly I18nAllowlistEntry[] = [];
