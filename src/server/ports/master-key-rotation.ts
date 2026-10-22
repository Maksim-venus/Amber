/**
 * The second step of "reset all credentials": after the database no longer
 * holds any envelope, the master key may be replaced. Separate and retryable: a crash
 * between the two steps leaves nothing that needs the old key.
 */
export interface MasterKeyRotation {
  rotate(): Promise<void>;
}
