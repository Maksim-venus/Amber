import { join } from "node:path";
import { monotonicFactory } from "ulid";
import { openDatabase } from "../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../src/server/adapters/sqlite/repository.ts";
import { E2E_SERVER_DATA_DIR_ENV } from "./constants.ts";

/**
 * Direct writes into the running e2e backend's database (SQLite allows a second
 * connection): what an import or a finished summary stage would have stored, so the
 * browser checks need no platform or model call.
 */

const newId = monotonicFactory();

function withRepository<T>(work: (repository: SqliteRepository) => T): T {
  const dataDir = process.env[E2E_SERVER_DATA_DIR_ENV];
  if (dataDir === undefined) {
    throw new Error(`${E2E_SERVER_DATA_DIR_ENV} is not set; run through the Playwright config`);
  }
  const { db } = openDatabase(join(dataDir, "amber.db"), { backupDir: join(dataDir, "backups") });
  try {
    return work(new SqliteRepository(db));
  } finally {
    db.close();
  }
}

export function userIdOf(username: string): string {
  return withRepository((repository) => {
    const credential = repository.withTransaction((scope) => scope.users.findCredentialByUsername(username));
    if (credential === undefined) {
      throw new Error(`no user ${username}`);
    }
    return credential.userId;
  });
}

/** A processed local Content without media, titled `title`. */
export function seedContent(userId: string, title: string): string {
  const id = newId();
  const now = Date.now();
  withRepository((repository) =>
    repository.withTransaction((scope) =>
      scope.contents.insert({ id, userId, source: { kind: "local" }, title, processingStatus: "succeeded", createdAt: now, updatedAt: now }),
    ),
  );
  return id;
}

/** A current `summary.core` revision on the Content's (latest) transcript, made primary, citing its first segment. */
export function seedSummary(userId: string, contentId: string, body: (citation: string) => string): void {
  withRepository((repository) =>
    repository.withTransaction((scope) => {
      // The imported subtitle becomes primary when nothing else is; otherwise make it so.
      const revisionId = scope.contents.get(userId, contentId)?.primaryTranscriptRevisionId ?? scope.transcripts.listRevisions(userId, contentId).at(-1)?.id;
      if (revisionId === undefined) {
        throw new Error("the content has no transcript");
      }
      scope.contents.setPrimaryTranscript(userId, contentId, revisionId, Date.now());
      const [first] = scope.transcripts.listSegments(userId, revisionId, { limit: 1 });
      if (first === undefined) {
        throw new Error("the primary transcript has no segment");
      }
      const summaryRevisionId = newId();
      const inserted = scope.summaries.insertRevision(userId, {
        contentId,
        templateId: "summary.core",
        artifactId: newId(),
        revision: {
          id: summaryRevisionId,
          provenance: {
            inputs: [{ kind: "transcriptRevision", id: revisionId }],
            modelRef: { providerProfileId: "p", modelId: "m", providerNameSnapshot: "relay", modelDisplaySnapshot: "m" },
            promptRef: { id: "summary.core", version: 1 },
            promptSnapshot: "<summary prompt>",
            createdAt: Date.now(),
          },
          quality: "normal",
          body: body(`[[seg:${first.id}]]`),
          citations: [{ transcriptRevisionId: revisionId, segmentId: first.id }],
        },
      });
      scope.summaries.setCurrent(userId, inserted.artifactId, summaryRevisionId);
    }),
  );
}
