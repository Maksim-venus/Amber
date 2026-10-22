import type { Session } from "../../../domain/runtime-support.ts";
import type { SessionRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { withoutNulls } from "./rows.ts";

interface SessionRow {
  session_id_hash: string;
  user_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export function sqliteSessionRepository(db: SqliteConnection): SessionRepository {
  const select = db.prepare("SELECT * FROM session WHERE session_id_hash = ?");
  const insert = db.prepare(
    `INSERT INTO session (session_id_hash, user_id, created_at, last_seen_at, expires_at)
     VALUES (@sessionIdHash, @userId, @createdAt, @lastSeenAt, @expiresAt)`,
  );
  const touch = db.prepare(
    "UPDATE session SET last_seen_at = ?, expires_at = ? WHERE session_id_hash = ? AND revoked_at IS NULL",
  );
  const revoke = db.prepare("UPDATE session SET revoked_at = ? WHERE session_id_hash = ? AND revoked_at IS NULL");
  const liveOf = db.prepare("SELECT session_id_hash FROM session WHERE user_id = ? AND revoked_at IS NULL");
  const deleteStale = db.prepare("DELETE FROM session WHERE expires_at <= ? OR revoked_at IS NOT NULL");
  return {
    get(sessionIdHash) {
      const row = select.get(sessionIdHash) as SessionRow | undefined;
      return row === undefined
        ? undefined
        : withoutNulls<Session>({
            sessionIdHash: row.session_id_hash,
            userId: row.user_id,
            createdAt: row.created_at,
            lastSeenAt: row.last_seen_at,
            expiresAt: row.expires_at,
            revokedAt: row.revoked_at,
          });
    },
    insert(session) {
      insert.run({
        sessionIdHash: session.sessionIdHash,
        userId: session.userId,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
      });
    },
    touch(sessionIdHash, lastSeenAt, expiresAt) {
      touch.run(lastSeenAt, expiresAt, sessionIdHash);
    },
    revoke(sessionIdHash, revokedAt) {
      return revoke.run(revokedAt, sessionIdHash).changes > 0;
    },
    revokeAllOf(userId, revokedAt, options = {}) {
      const hashes = (liveOf.all(userId) as Array<{ session_id_hash: string }>)
        .map((row) => row.session_id_hash)
        .filter((hash) => hash !== options.except);
      for (const hash of hashes) {
        revoke.run(revokedAt, hash);
      }
      return hashes;
    },
    deleteStale(now) {
      return deleteStale.run(now).changes;
    },
  };
}
