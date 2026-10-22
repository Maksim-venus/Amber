/**
 * Sessions revoked by this process. Revocation is written to the database
 * and recorded here in the same step, so open SSE streams can close before their next
 * push without a database read; heartbeats still re-check the database.
 */
export class SessionRevocations {
  private readonly revoked = new Set<string>();

  add(sessionIdHashes: Iterable<string>): void {
    for (const hash of sessionIdHashes) {
      this.revoked.add(hash);
    }
  }

  has(sessionIdHash: string): boolean {
    return this.revoked.has(sessionIdHash);
  }
}
