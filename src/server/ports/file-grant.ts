import type { FileGrant, FileGrantPurpose } from "../../shared/dto/local-media.ts";

/**
 * Checks that a local path was picked by the user in the desktop shell's file dialog.
 * The sidecar never trusts a bare path from the WebView.
 */
export interface FileGrantVerifier {
  /** True only for an unexpired grant signed for exactly this path and purpose. */
  verify(grant: FileGrant, expected: { path: string; purpose: FileGrantPurpose }): boolean;
}

/**
 * The purposes the sidecar signs itself. Every other purpose is the shell's: a grant the
 * sidecar could issue for `local_file` or `cache_dir` would pass its own verifier.
 */
export type IssuedFileGrantPurpose = Extract<FileGrantPurpose, "burn_output" | "cache_save">;

/**
 * The sidecar's side of the reverse direction: a `burn_output` grant
 * for a burn product in the data directory, or a `cache_save` grant for a file in the
 * media cache directory, which the shell checks before copying the file out.
 */
export interface FileGrantIssuer {
  /** Signs `path` for `purpose`, valid for `FILE_GRANT_TTL_MS` from now. */
  issue(grant: { path: string; purpose: IssuedFileGrantPurpose }): FileGrant;
}
