import type { User, UserCredential } from "../../../domain/user.ts";
import type { UserRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { nullable, withoutNulls } from "./rows.ts";

interface UserRow {
  id: string;
  role: User["role"];
  status: User["status"];
  display_name: string | null;
  storage_limit_gb: number | null;
  created_at: number;
}

interface CredentialRow {
  user_id: string;
  username: string;
  password_hash: string;
  must_change_password: number;
}

function toUser(row: UserRow): User {
  return withoutNulls<User>({
    id: row.id,
    role: row.role,
    status: row.status,
    displayName: row.display_name,
    storageLimitGB: row.storage_limit_gb,
    createdAt: row.created_at,
  });
}

function toCredential(row: CredentialRow): UserCredential {
  return {
    userId: row.user_id,
    username: row.username,
    passwordHash: row.password_hash,
    mustChangePassword: row.must_change_password === 1,
  };
}

export function sqliteUserRepository(db: SqliteConnection): UserRepository {
  const select = db.prepare("SELECT * FROM user WHERE id = ?");
  const selectAll = db.prepare("SELECT * FROM user ORDER BY created_at, id");
  const insert = db.prepare(
    `INSERT INTO user (id, role, status, display_name, storage_limit_gb, created_at)
     VALUES (@id, @role, @status, @displayName, @storageLimitGB, @createdAt)`,
  );
  const update = db.prepare(
    `UPDATE user SET role = @role, status = @status, display_name = @displayName, storage_limit_gb = @storageLimitGB
     WHERE id = @id`,
  );
  const countAdmins = db.prepare("SELECT count(*) AS n FROM user WHERE role = 'admin' AND status = 'active'");
  const remove = db.prepare("DELETE FROM user WHERE id = ?");
  // The search projection has no foreign keys; its rows go with the user explicitly.
  const removeSearchRows = db.prepare("DELETE FROM search_index WHERE user_id = ?");
  const selectCredential = db.prepare("SELECT * FROM user_credential WHERE user_id = ?");
  const selectCredentialByName = db.prepare("SELECT * FROM user_credential WHERE username = ?");
  const putCredential = db.prepare(
    `INSERT INTO user_credential (user_id, username, password_hash, must_change_password)
     VALUES (@userId, @username, @passwordHash, @mustChangePassword)
     ON CONFLICT (user_id) DO UPDATE SET
       username = excluded.username, password_hash = excluded.password_hash,
       must_change_password = excluded.must_change_password`,
  );
  const anyCredential = db.prepare("SELECT 1 FROM user_credential LIMIT 1");
  return {
    get(userId) {
      const row = select.get(userId) as UserRow | undefined;
      return row === undefined ? undefined : toUser(row);
    },
    list() {
      return (selectAll.all() as UserRow[]).map(toUser);
    },
    insert(user) {
      insert.run({
        id: user.id,
        role: user.role,
        status: user.status,
        displayName: nullable(user.displayName),
        storageLimitGB: nullable(user.storageLimitGB),
        createdAt: user.createdAt,
      });
    },
    update(user) {
      const changed = update.run({
        id: user.id,
        role: user.role,
        status: user.status,
        displayName: nullable(user.displayName),
        storageLimitGB: nullable(user.storageLimitGB),
      }).changes;
      if (changed === 0) {
        throw new Error(`user ${user.id} not found`);
      }
    },
    countActiveAdmins() {
      return (countAdmins.get() as { n: number }).n;
    },
    delete(userId) {
      removeSearchRows.run(userId);
      return remove.run(userId).changes > 0;
    },
    getCredential(userId) {
      const row = selectCredential.get(userId) as CredentialRow | undefined;
      return row === undefined ? undefined : toCredential(row);
    },
    findCredentialByUsername(username) {
      const row = selectCredentialByName.get(username) as CredentialRow | undefined;
      return row === undefined ? undefined : toCredential(row);
    },
    putCredential(credential) {
      putCredential.run({
        userId: credential.userId,
        username: credential.username,
        passwordHash: credential.passwordHash,
        mustChangePassword: credential.mustChangePassword ? 1 : 0,
      });
    },
    anyCredential() {
      return anyCredential.get() !== undefined;
    },
  };
}
