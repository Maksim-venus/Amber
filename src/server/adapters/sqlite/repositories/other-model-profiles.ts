import type { OtherModelEntry, OtherModelProfile } from "../../../domain/provider-profile.ts";
import type { OtherModelProfileRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { notFound, nullable, parseJson, withoutNulls } from "./rows.ts";

interface OtherModelProfileRow {
  id: string;
  user_id: string;
  name: string;
  note: string | null;
  models_json: string;
  created_at: number;
}

export function sqliteOtherModelProfileRepository(db: SqliteConnection): OtherModelProfileRepository {
  const select = db.prepare("SELECT * FROM other_model_profile WHERE id = ? AND user_id = ?");
  const selectAll = db.prepare("SELECT * FROM other_model_profile WHERE user_id = ? ORDER BY position, created_at, id");
  const insert = db.prepare(
    // A new profile goes last in the user's order.
    `INSERT INTO other_model_profile (id, user_id, name, note, models_json, created_at, position)
     VALUES (@id, @userId, @name, @note, @modelsJson, @createdAt,
       (SELECT coalesce(max(position) + 1, 0) FROM other_model_profile WHERE user_id = @userId))`,
  );
  const update = db.prepare("UPDATE other_model_profile SET name = @name, note = @note, models_json = @modelsJson WHERE id = @id AND user_id = @userId");
  const remove = db.prepare("DELETE FROM other_model_profile WHERE id = ? AND user_id = ?");
  const setPosition = db.prepare("UPDATE other_model_profile SET position = ? WHERE id = ? AND user_id = ?");

  const params = (profile: OtherModelProfile) => ({
    id: profile.id,
    userId: profile.userId,
    name: profile.name,
    note: nullable(profile.note),
    modelsJson: JSON.stringify(profile.models),
  });

  return {
    get(ownerUserId, profileId) {
      const row = select.get(profileId, ownerUserId) as OtherModelProfileRow | undefined;
      return row === undefined ? undefined : toProfile(row);
    },
    list(ownerUserId) {
      return (selectAll.all(ownerUserId) as OtherModelProfileRow[]).map(toProfile);
    },
    insert(profile) {
      insert.run({ ...params(profile), createdAt: profile.createdAt });
    },
    update(profile) {
      return update.run(params(profile)).changes > 0;
    },
    delete(ownerUserId, profileId) {
      return remove.run(profileId, ownerUserId).changes > 0;
    },
    reorder(ownerUserId, profileIds) {
      profileIds.forEach((profileId, position) => {
        if (setPosition.run(position, profileId, ownerUserId).changes === 0) {
          throw notFound("other model profile", profileId);
        }
      });
    },
  };
}

function toProfile(row: OtherModelProfileRow): OtherModelProfile {
  return withoutNulls<OtherModelProfile>({
    id: row.id,
    userId: row.user_id,
    name: row.name,
    note: row.note,
    models: parseJson<OtherModelEntry[]>(row.models_json),
    createdAt: row.created_at,
  });
}
