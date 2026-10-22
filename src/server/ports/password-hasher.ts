/**
 * Password hashing for server-mode login credentials: argon2id with its
 * parameters encoded into the hash, so a hash made with older parameters still verifies
 * and reports that it should be re-hashed.
 */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(passwordHash: string, password: string): Promise<{ valid: boolean; needsRehash: boolean }>;
}
