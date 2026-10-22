import type { IdempotencyRecord } from "../../../domain/runtime-support.ts";
import type { IdempotencyRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";

interface IdempotencyRow {
  user_id: string;
  route: string;
  idempotency_key: string;
  request_digest: string;
  response_status: number;
  response_body_json: string;
  resource_refs_json: string;
  created_at: number;
}

export function sqliteIdempotencyRepository(db: SqliteConnection): IdempotencyRepository {
  const select = db.prepare("SELECT * FROM idempotency_record WHERE user_id = ? AND route = ? AND idempotency_key = ?");
  const insert = db.prepare(
    `INSERT INTO idempotency_record (
       user_id, route, idempotency_key, request_digest, response_status, response_body_json, resource_refs_json, created_at
     ) VALUES (@userId, @route, @key, @requestDigest, @responseStatus, @responseBodyJson, @resourceRefsJson, @createdAt)`,
  );

  return {
    get(ownerUserId, route, key): IdempotencyRecord | undefined {
      const row = select.get(ownerUserId, route, key) as IdempotencyRow | undefined;
      return row === undefined
        ? undefined
        : {
            userId: row.user_id,
            route: row.route,
            key: row.idempotency_key,
            requestDigest: row.request_digest,
            responseStatus: row.response_status,
            responseBodyJson: row.response_body_json,
            resourceRefsJson: row.resource_refs_json,
            createdAt: row.created_at,
          };
    },
    insert(record) {
      insert.run({ ...record });
    },
  };
}
