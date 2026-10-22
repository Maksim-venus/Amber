import type { Migration } from "../migrations.ts";

/** Milestone 0 sentinel: a single row written once at creation that upgrades must carry over unchanged. */
export const migration0001: Migration = {
  version: 1,
  name: "m0-sentinel",
  sql: `
      CREATE TABLE m0_sentinel (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        created_at INTEGER NOT NULL,
        marker TEXT NOT NULL
      );
      INSERT INTO m0_sentinel (id, created_at, marker)
      VALUES (1, CAST(unixepoch('subsec') * 1000 AS INTEGER), lower(hex(randomblob(8))));
    `,
};
