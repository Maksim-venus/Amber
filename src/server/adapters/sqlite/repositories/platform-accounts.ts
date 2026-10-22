import type { PlatformAccount } from "../../../domain/provider-profile.ts";
import type { PlatformAccountRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { notFound, nullable, withoutNulls } from "./rows.ts";

interface PlatformAccountRow {
  id: string;
  user_id: string;
  platform: PlatformAccount["platform"];
  credential_ref: string;
  status: PlatformAccount["status"];
  checked_at: number | null;
}

function toAccount(row: PlatformAccountRow): PlatformAccount {
  return withoutNulls<PlatformAccount>({
    id: row.id,
    userId: row.user_id,
    platform: row.platform,
    credentialRef: row.credential_ref,
    status: row.status,
    checkedAt: row.checked_at,
  });
}

export function sqlitePlatformAccountRepository(db: SqliteConnection): PlatformAccountRepository {
  const select = db.prepare("SELECT * FROM platform_account WHERE user_id = ? AND platform = ?");
  const list = db.prepare("SELECT * FROM platform_account WHERE user_id = ? ORDER BY platform");
  const insert = db.prepare(
    `INSERT INTO platform_account (id, user_id, platform, credential_ref, status, checked_at)
     VALUES (@id, @userId, @platform, @credentialRef, @status, @checkedAt)`,
  );
  const setStatus = db.prepare("UPDATE platform_account SET status = ?, checked_at = ? WHERE user_id = ? AND platform = ?");
  const remove = db.prepare("DELETE FROM platform_account WHERE user_id = ? AND platform = ?");
  // Each row's secret goes with it through the platform_account_secret_delete trigger.
  const removeAll = db.prepare("DELETE FROM platform_account");

  return {
    get(ownerUserId, platform) {
      const row = select.get(ownerUserId, platform) as PlatformAccountRow | undefined;
      return row === undefined ? undefined : toAccount(row);
    },
    list(ownerUserId) {
      return (list.all(ownerUserId) as PlatformAccountRow[]).map(toAccount);
    },
    insert(account) {
      insert.run({
        id: account.id,
        userId: account.userId,
        platform: account.platform,
        credentialRef: account.credentialRef,
        status: account.status,
        checkedAt: nullable(account.checkedAt),
      });
    },
    setStatus(ownerUserId, platform, status, checkedAt) {
      if (setStatus.run(status, nullable(checkedAt), ownerUserId, platform).changes === 0) {
        throw notFound("platform account", platform);
      }
    },
    delete(ownerUserId, platform) {
      return remove.run(ownerUserId, platform).changes > 0;
    },
    deleteAll() {
      return removeAll.run().changes;
    },
  };
}
