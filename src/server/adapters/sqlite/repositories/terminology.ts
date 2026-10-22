import { effectiveTerminology, type TerminologyEntry, type TerminologyScope, type TerminologySet } from "../../../domain/terminology.ts";
import type { TerminologyRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { notFound, nullable, withoutNulls } from "./rows.ts";

interface SetRow {
  id: string;
  user_id: string;
  scope_kind: TerminologySet["scope"]["kind"];
  collection_id: string | null;
  content_id: string | null;
}

interface EntryRow {
  id: string;
  ordinal: number;
  term: string;
  normalized_key: string;
  translation: string | null;
  rule: NonNullable<TerminologyEntry["rule"]> | null;
}

/** Every lookup is filtered by owner, so another user's sets never take part. */
export function sqliteTerminologyRepository(db: SqliteConnection): TerminologyRepository {
  const contentSet = db.prepare("SELECT * FROM terminology_set WHERE user_id = ? AND scope_kind = 'content' AND content_id = ?");
  // Collections in ascending order of when the Content was added to each.
  const collectionSets = db.prepare(
    `SELECT terminology_set.* FROM terminology_set
     JOIN collection_item ON collection_item.collection_id = terminology_set.collection_id
     WHERE terminology_set.user_id = ? AND terminology_set.scope_kind = 'collection' AND collection_item.content_id = ?
     ORDER BY collection_item.added_at, collection_item.id`,
  );
  const globalSet = db.prepare("SELECT * FROM terminology_set WHERE user_id = ? AND scope_kind = 'global'");
  const entries = db.prepare("SELECT * FROM terminology_entry WHERE set_id = ? ORDER BY ordinal, id");
  const collectionSet = db.prepare("SELECT * FROM terminology_set WHERE user_id = ? AND scope_kind = 'collection' AND collection_id = ?");
  const ownedCollection = db.prepare("SELECT 1 FROM collection WHERE id = ? AND user_id = ?");
  const ownedContent = db.prepare("SELECT 1 FROM content WHERE id = ? AND user_id = ?");
  const insertSet = db.prepare(
    "INSERT INTO terminology_set (id, user_id, scope_kind, collection_id, content_id) VALUES (@id, @userId, @scopeKind, @collectionId, @contentId)",
  );
  // Entries cascade with their set.
  const deleteSet = db.prepare("DELETE FROM terminology_set WHERE id = ?");
  const deleteEntries = db.prepare("DELETE FROM terminology_entry WHERE set_id = ?");
  const insertEntry = db.prepare(
    `INSERT INTO terminology_entry (id, set_id, ordinal, term, normalized_key, translation, rule)
     VALUES (@id, @setId, @ordinal, @term, @normalizedKey, @translation, @rule)`,
  );

  const setRowOf = (ownerUserId: string, scope: TerminologyScope): SetRow | undefined => {
    switch (scope.kind) {
      case "global":
        return globalSet.get(ownerUserId) as SetRow | undefined;
      case "collection":
        return collectionSet.get(ownerUserId, scope.collectionId) as SetRow | undefined;
      case "content":
        return contentSet.get(ownerUserId, scope.contentId) as SetRow | undefined;
    }
  };

  const toSet = (row: SetRow): TerminologySet => ({
    id: row.id,
    userId: row.user_id,
    scope:
      row.scope_kind === "content"
        ? { kind: "content", contentId: row.content_id as string }
        : row.scope_kind === "collection"
          ? { kind: "collection", collectionId: row.collection_id as string }
          : { kind: "global" },
    entries: (entries.all(row.id) as EntryRow[]).map((entry) =>
      withoutNulls<TerminologyEntry>({
        id: entry.id,
        ordinal: entry.ordinal,
        term: entry.term,
        normalizedKey: entry.normalized_key,
        translation: entry.translation,
        rule: entry.rule,
      }),
    ),
  });

  return {
    get(ownerUserId, scope) {
      const row = setRowOf(ownerUserId, scope);
      return row === undefined ? undefined : toSet(row);
    },
    put(set) {
      const { scope, userId } = set;
      if (scope.kind === "collection" && ownedCollection.get(scope.collectionId, userId) === undefined) {
        throw notFound("collection", scope.collectionId);
      }
      if (scope.kind === "content" && ownedContent.get(scope.contentId, userId) === undefined) {
        throw notFound("content", scope.contentId);
      }
      const existing = setRowOf(userId, scope);
      if (set.entries.length === 0) {
        if (existing !== undefined) {
          deleteSet.run(existing.id);
        }
        return;
      }
      // An existing set keeps its id; `set.id` only names a set created here.
      const setId = existing?.id ?? set.id;
      if (existing === undefined) {
        insertSet.run({
          id: setId,
          userId,
          scopeKind: scope.kind,
          collectionId: scope.kind === "collection" ? scope.collectionId : null,
          contentId: scope.kind === "content" ? scope.contentId : null,
        });
      } else {
        deleteEntries.run(setId);
      }
      for (const entry of set.entries) {
        insertEntry.run({
          id: entry.id,
          setId,
          ordinal: entry.ordinal,
          term: entry.term,
          normalizedKey: entry.normalizedKey,
          translation: nullable(entry.translation),
          rule: nullable(entry.rule),
        });
      }
    },
    effectiveFor(ownerUserId, contentId) {
      const content = contentSet.get(ownerUserId, contentId) as SetRow | undefined;
      const global = globalSet.get(ownerUserId) as SetRow | undefined;
      return effectiveTerminology({
        ...(content === undefined ? {} : { content: toSet(content) }),
        collections: (collectionSets.all(ownerUserId, contentId) as SetRow[]).map(toSet),
        ...(global === undefined ? {} : { global: toSet(global) }),
      });
    },
    effectiveForCollection(ownerUserId, collectionId) {
      // The set lookup is filtered by owner, so another user's collection contributes nothing.
      const collection = collectionSet.get(ownerUserId, collectionId) as SetRow | undefined;
      const global = globalSet.get(ownerUserId) as SetRow | undefined;
      return effectiveTerminology({
        collections: collection === undefined ? [] : [toSet(collection)],
        ...(global === undefined ? {} : { global: toSet(global) }),
      });
    },
  };
}
