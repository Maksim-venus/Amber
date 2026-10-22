import type { CacheMigrationMarker, InstanceSettings } from "../../../domain/runtime-support.ts";
import type { InstanceSettingsRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { jsonOrNull, nullable, withoutNulls } from "./rows.ts";

interface InstanceSettingsRow {
  concurrency_pipeline: number;
  max_data_gb: number;
  low_water_free_gb: number;
  low_water_free_ratio: number;
  upload_retention_default: InstanceSettings["uploadRetentionDefault"];
  credentials_reset_at: number | null;
  cache_root: string | null;
  cache_migration_json: string | null;
  updated_at: number;
}

const MIGRATION_PHASES: ReadonlySet<string> = new Set<CacheMigrationMarker["phase"]>(["copying", "cleanup_pending"]);

/**
 * A marker that does not parse is a corrupt row, not an absent move: failing closed keeps
 * the start-up recovery from silently skipping a cleanup or a rollback.
 */
function parseMarker(json: string): CacheMigrationMarker {
  const value = JSON.parse(json) as Partial<CacheMigrationMarker> | null;
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.id !== "string" ||
    typeof value.from !== "string" ||
    typeof value.to !== "string" ||
    typeof value.phase !== "string" ||
    !MIGRATION_PHASES.has(value.phase)
  ) {
    throw new TypeError("instance_settings.cache_migration_json is not a cache migration marker");
  }
  return { id: value.id, from: value.from, to: value.to, phase: value.phase };
}

export function sqliteInstanceSettingsRepository(db: SqliteConnection): InstanceSettingsRepository {
  const select = db.prepare("SELECT * FROM instance_settings WHERE id = 1");
  const put = db.prepare(
    `INSERT OR REPLACE INTO instance_settings (
       id, concurrency_pipeline, max_data_gb, low_water_free_gb,
       low_water_free_ratio, upload_retention_default, credentials_reset_at, cache_root, cache_migration_json, updated_at
     ) VALUES (
       1, @concurrencyPipeline, @maxDataGB, @lowWaterFreeGB,
       @lowWaterFreeRatio, @uploadRetentionDefault, @credentialsResetAt, @cacheRoot, @cacheMigrationJson, @updatedAt
     )`,
  );

  return {
    get() {
      const row = select.get() as InstanceSettingsRow | undefined;
      return row === undefined
        ? undefined
        : withoutNulls<InstanceSettings>({
            concurrencyPipeline: row.concurrency_pipeline,
            maxDataGB: row.max_data_gb,
            lowWaterFreeGB: row.low_water_free_gb,
            lowWaterFreeRatio: row.low_water_free_ratio,
            uploadRetentionDefault: row.upload_retention_default,
            credentialsResetAt: row.credentials_reset_at,
            cacheRoot: row.cache_root,
            cacheMigration: row.cache_migration_json === null ? null : parseMarker(row.cache_migration_json),
            updatedAt: row.updated_at,
          });
    },
    put(settings) {
      put.run({
        concurrencyPipeline: settings.concurrencyPipeline,
        maxDataGB: settings.maxDataGB,
        lowWaterFreeGB: settings.lowWaterFreeGB,
        lowWaterFreeRatio: settings.lowWaterFreeRatio,
        uploadRetentionDefault: settings.uploadRetentionDefault,
        credentialsResetAt: nullable(settings.credentialsResetAt),
        cacheRoot: nullable(settings.cacheRoot),
        cacheMigrationJson: jsonOrNull(settings.cacheMigration),
        updatedAt: settings.updatedAt,
      });
    },
  };
}
