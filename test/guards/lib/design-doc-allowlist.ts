/**
 * Exceptions to the design-document reference guard. Each entry names one matched text in
 * one file and why it is not a reference to an internal design document; there is no
 * directory-wide exemption. Keep the list short and give every entry a reason a reviewer
 * can check. An entry that no longer matches anything is itself reported, so the list
 * cannot silently outlive the text it excuses.
 */
export interface DesignDocAllowlistEntry {
  /** Repository-relative path with forward slashes. */
  file: string;
  /** The matched text exactly as it appears in the file (or in its path). */
  pattern: string;
  reason: string;
}

export const DESIGN_DOC_ALLOWLIST: readonly DesignDocAllowlistEntry[] = [];
