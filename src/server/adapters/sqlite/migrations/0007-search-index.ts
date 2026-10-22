import type { Migration } from "../migrations.ts";

/**
 * The search projection: one FTS5 table with the `trigram` tokenizer,
 * so Chinese and mixed text match by substring. Only `text` is indexed; the other columns
 * locate the hit. Content rows (`title / segment / summary / reference`) carry no collection
 * column; collection rows (`kind = collection`) carry no content. The table is derived
 * data: the application fills it on start-up when it is empty or unhealthy.
 */
export const migration0007: Migration = {
  version: 7,
  name: "search-index",
  sql: `
    CREATE VIRTUAL TABLE search_index USING fts5(
      text,
      kind UNINDEXED,
      user_id UNINDEXED,
      content_id UNINDEXED,
      collection_id UNINDEXED,
      revision_id UNINDEXED,
      segment_id UNINDEXED,
      start_ms UNINDEXED,
      tokenize = 'trigram'
    );
  `,
};
