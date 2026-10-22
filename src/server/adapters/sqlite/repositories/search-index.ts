import { questionTrigrams } from "../../../domain/search-query.ts";
import type { SearchIndexHit, SearchIndexQuery, SearchIndexRepository } from "../../../ports/repository.ts";
import type { SqliteConnection, SqliteStatement } from "../database.ts";

/** Citation markers carry ids, not words; they are left out of the indexed text. */
const MARKERS = /\[\[(?:seg|unresolved):[^\]]*\]\]/g;

const COLUMNS = "text, kind, user_id, content_id, collection_id, revision_id, segment_id, start_ms";

/** A whole term as one FTS5 string: inner quotes doubled, so input never becomes query syntax. */
function ftsString(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

/** A `LIKE` pattern matching `term` literally anywhere; `\` is the escape character. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

interface HitRow {
  kind: SearchIndexHit["kind"];
  content_id: string | null;
  collection_id: string | null;
  revision_id: string | null;
  segment_id: string | null;
  start_ms: number | null;
  text: string;
  artifact_id: string | null;
  template_id: string | null;
}

function toHit(row: HitRow): SearchIndexHit {
  switch (row.kind) {
    case "segment":
      return {
        kind: "segment",
        contentId: row.content_id as string,
        transcriptRevisionId: row.revision_id as string,
        segmentId: row.segment_id as string,
        startMs: row.start_ms as number,
        text: row.text,
      };
    case "summary":
      return {
        kind: "summary",
        contentId: row.content_id as string,
        artifactId: row.artifact_id as string,
        templateId: row.template_id as string,
        summaryRevisionId: row.revision_id as string,
        text: row.text,
      };
    case "collection":
      return { kind: "collection", collectionId: row.collection_id as string, text: row.text };
    default:
      return { kind: row.kind, contentId: row.content_id as string, text: row.text };
  }
}

/** Kinds in the order a `like` scan reports them, so short lists still show titles first. */
const LIKE_ORDER = ["title", "collection", "reference", "summary", "segment"] as const;

/**
 * The FTS5 projection, derived from the business tables with
 * `INSERT … SELECT`; summary bodies pass through JavaScript to drop citation markers.
 * Rows are located by their UNINDEXED columns, so re-deriving one Content scans the table:
 * acceptable at personal-library scale, revisited if libraries grow large.
 */
export function sqliteSearchIndexRepository(db: SqliteConnection): SearchIndexRepository {
  // `@all = 1` lifts the owner / id filter for a full rebuild; a trashed Content is never projected.
  const contentFilter = "(@all = 1 OR (c.user_id = @owner AND c.id = @contentId)) AND c.trashed_at IS NULL";
  const insertTitles = db.prepare(
    `INSERT INTO search_index (${COLUMNS})
     SELECT coalesce(c.custom_title, c.title), 'title', c.user_id, c.id, NULL, NULL, NULL, NULL FROM content c
     WHERE ${contentFilter} AND coalesce(c.custom_title, c.title) IS NOT NULL AND coalesce(c.custom_title, c.title) <> ''`,
  );
  const insertSegments = db.prepare(
    `INSERT INTO search_index (${COLUMNS})
     SELECT s.text, 'segment', c.user_id, c.id, NULL, s.revision_id, s.id, s.start_ms
     FROM content c JOIN transcript_segment s ON s.revision_id = c.primary_transcript_revision_id
     WHERE ${contentFilter} ORDER BY c.id, s.ordinal`,
  );
  const insertReferences = db.prepare(
    `INSERT INTO search_index (${COLUMNS})
     SELECT r.text, 'reference', c.user_id, c.id, NULL, r.id, NULL, NULL
     FROM content c JOIN reference_text r ON r.content_id = c.id
     WHERE ${contentFilter} ORDER BY c.id, r.created_at, r.id`,
  );
  const currentSummaries = db.prepare(
    `SELECT r.id AS revision_id, r.body, c.user_id, c.id AS content_id
     FROM content c JOIN summary_artifact a ON a.content_id = c.id JOIN summary_revision r ON r.id = a.current_revision_id
     WHERE ${contentFilter} ORDER BY c.id, a.template_id`,
  );
  const insertRow = db.prepare(
    `INSERT INTO search_index (${COLUMNS}) VALUES (@text, @kind, @userId, @contentId, @collectionId, @revisionId, NULL, NULL)`,
  );
  const insertCollections = db.prepare(
    `INSERT INTO search_index (${COLUMNS})
     SELECT trim(k.name || ' ' || coalesce(k.description, '')), 'collection', k.user_id, NULL, k.id, NULL, NULL, NULL
     FROM collection k WHERE (@all = 1 OR (k.user_id = @owner AND k.id = @collectionId))`,
  );
  const deleteContent = db.prepare("DELETE FROM search_index WHERE user_id = ? AND content_id = ?");
  const deleteCollection = db.prepare("DELETE FROM search_index WHERE user_id = ? AND kind = 'collection' AND collection_id = ?");
  const deleteAll = db.prepare("DELETE FROM search_index");
  const anyRow = db.prepare("SELECT 1 FROM search_index LIMIT 1");
  const anySource = db.prepare("SELECT 1 FROM content WHERE trashed_at IS NULL UNION ALL SELECT 1 FROM collection LIMIT 1");
  const matchSegments = db.prepare(
    `SELECT segment_id FROM search_index
     WHERE search_index MATCH @match AND user_id = @owner AND kind = 'segment' AND revision_id = @revisionId
     ORDER BY bm25(search_index) LIMIT @limit`,
  );

  const projectContent = (params: { all: number; owner: string | null; contentId: string | null }): void => {
    insertTitles.run(params);
    insertSegments.run(params);
    insertReferences.run(params);
    const summaries = currentSummaries.all(params) as Array<{ revision_id: string; body: string; user_id: string; content_id: string }>;
    for (const summary of summaries) {
      insertRow.run({
        text: summary.body.replace(MARKERS, " "),
        kind: "summary",
        userId: summary.user_id,
        contentId: summary.content_id,
        collectionId: null,
        revisionId: summary.revision_id,
      });
    }
  };

  // Prepared per shape: the number of terms varies with the query.
  const statements = new Map<string, SqliteStatement>();
  const statement = (sql: string): SqliteStatement => {
    let prepared = statements.get(sql);
    if (prepared === undefined) {
      prepared = db.prepare(sql);
      statements.set(sql, prepared);
    }
    return prepared;
  };

  const SELECT_HIT = `SELECT si.kind, si.content_id, si.collection_id, si.revision_id, si.segment_id, si.start_ms, si.text,
      a.id AS artifact_id, a.template_id
    FROM search_index si
    LEFT JOIN summary_revision sr ON si.kind = 'summary' AND sr.id = si.revision_id
    LEFT JOIN summary_artifact a ON a.id = sr.artifact_id`;

  /** Scope condition and its parameters; content scopes never return collection rows. */
  const scopeOf = (query: SearchIndexQuery): { sql: string; params: unknown[]; kinds: readonly string[] } => {
    switch (query.scope.kind) {
      case "global":
        return { sql: "", params: [], kinds: LIKE_ORDER };
      case "library":
        return { sql: "", params: [], kinds: LIKE_ORDER.filter((kind) => kind !== "collection") };
      case "collection":
        return {
          sql: " AND si.content_id IN (SELECT content_id FROM collection_item WHERE collection_id = ?)",
          params: [query.scope.collectionId],
          kinds: LIKE_ORDER.filter((kind) => kind !== "collection"),
        };
    }
  };

  return {
    syncContent(ownerUserId, contentId) {
      deleteContent.run(ownerUserId, contentId);
      projectContent({ all: 0, owner: ownerUserId, contentId });
    },
    removeContent(ownerUserId, contentId) {
      deleteContent.run(ownerUserId, contentId);
    },
    syncCollection(ownerUserId, collectionId) {
      deleteCollection.run(ownerUserId, collectionId);
      insertCollections.run({ all: 0, owner: ownerUserId, collectionId });
    },
    removeCollection(ownerUserId, collectionId) {
      deleteCollection.run(ownerUserId, collectionId);
    },
    query(ownerUserId, query) {
      if (query.terms.length === 0) {
        return [];
      }
      const scope = scopeOf(query);
      if (query.mode === "fts") {
        const match = query.terms.map(ftsString).join(" ");
        const hits: SearchIndexHit[] = [];
        for (const kind of scope.kinds) {
          const rows = statement(
            `${SELECT_HIT} WHERE search_index MATCH ? AND si.user_id = ? AND si.kind = ?${scope.sql}
             ORDER BY bm25(search_index), si.rowid LIMIT ?`,
          ).all(match, ownerUserId, kind, ...scope.params, query.groupLimit) as HitRow[];
          hits.push(...rows.map(toHit));
        }
        return hits;
      }
      const likes = query.terms.map(() => " AND si.text LIKE ? ESCAPE '\\'").join("");
      const kinds = scope.kinds.map(() => "?").join(", ");
      const order = scope.kinds.map((kind, index) => `WHEN '${kind}' THEN ${index}`).join(" ");
      const rows = statement(
        `${SELECT_HIT} WHERE si.user_id = ? AND si.kind IN (${kinds})${likes}${scope.sql}
         ORDER BY CASE si.kind ${order} END, si.rowid LIMIT ?`,
      ).all(ownerUserId, ...scope.kinds, ...query.terms.map(likePattern), ...scope.params, query.likeLimit) as HitRow[];
      const perKind = new Map<string, number>();
      const hits: SearchIndexHit[] = [];
      for (const row of rows) {
        const seen = perKind.get(row.kind) ?? 0;
        if (seen < query.groupLimit) {
          perKind.set(row.kind, seen + 1);
          hits.push(toHit(row));
        }
      }
      return hits;
    },
    matchSegments(ownerUserId, transcriptRevisionId, question, limit) {
      const grams = questionTrigrams(question);
      if (grams.length === 0 || limit <= 0) {
        return [];
      }
      const rows = matchSegments.all({ match: grams.map(ftsString).join(" OR "), owner: ownerUserId, revisionId: transcriptRevisionId, limit }) as Array<{
        segment_id: string;
      }>;
      return rows.map((row) => row.segment_id);
    },
    rebuild() {
      deleteAll.run();
      projectContent({ all: 1, owner: null, contentId: null });
      insertCollections.run({ all: 1, owner: null, collectionId: null });
    },
    healthy() {
      try {
        db.prepare("INSERT INTO search_index (search_index) VALUES ('integrity-check')").run();
      } catch {
        return false;
      }
      return !(anyRow.get() === undefined && anySource.get() !== undefined);
    },
  };
}
