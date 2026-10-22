import {
  CONCURRENCY_PIPELINE,
  LOW_WATER_FREE_GB,
  LOW_WATER_FREE_RATIO,
  MAX_DATA_GB,
  UPLOAD_RETENTION_DEFAULT,
} from "../../shared/defaults.ts";
import {
  CONCURRENCY_LIMITS,
  INSTANCE_SETTING_KEYS,
  instanceSettingsFieldsSchema,
  type InstanceSettingKey,
  type InstanceSettingsDto,
  type InstanceSettingsFields,
  type InstanceSettingsPatch,
} from "../../shared/dto/instance-settings.ts";
import { amberError } from "../domain/errors.ts";
import type { CacheMigrationMarker, InstanceSettings } from "../domain/runtime-support.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Repository } from "../ports/repository.ts";
import type { InstanceSettingsSource } from "../pipeline/scheduler.ts";

/** Environment variables that fix one instance setting each. */
export const INSTANCE_SETTING_ENV: Readonly<Record<InstanceSettingKey, string>> = {
  concurrencyPipeline: "AMBER_CONCURRENCY_PIPELINE",
  maxDataGB: "AMBER_MAX_DATA_GB",
  lowWaterFreeGB: "AMBER_LOW_WATER_FREE_GB",
  lowWaterFreeRatio: "AMBER_LOW_WATER_FREE_RATIO",
  uploadRetentionDefault: "AMBER_UPLOAD_RETENTION_DEFAULT",
};

/**
 * Variables of settings that no longer exist. Model requests and local heavy
 * work are now paced by the system, so a deployment still setting them expects a control
 * it no longer has; ignoring them silently would hide that.
 */
export const DEPRECATED_INSTANCE_SETTING_ENV: readonly string[] = ["AMBER_CONCURRENCY_HEAVY", "AMBER_CONCURRENCY_LLM"];

/**
 * Reads the instance-setting overrides from the environment. An invalid value, or a value
 * for a removed setting, stops the start: silently ignoring an administrator's explicit
 * setting would be worse.
 */
export function readInstanceSettingsEnv(env: Readonly<Record<string, string | undefined>>): Partial<InstanceSettingsFields> {
  for (const name of DEPRECATED_INSTANCE_SETTING_ENV) {
    const raw = env[name];
    if (raw !== undefined && raw.trim() !== "") {
      throw new Error(`${name} is no longer supported and must be removed`);
    }
  }
  const overrides: Record<string, unknown> = {};
  for (const key of INSTANCE_SETTING_KEYS) {
    const name = INSTANCE_SETTING_ENV[key];
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") {
      continue;
    }
    const value = key === "uploadRetentionDefault" ? raw.trim() : Number(raw);
    const parsed = instanceSettingsFieldsSchema.shape[key].safeParse(value);
    if (!parsed.success) {
      throw new Error(`${name} is not a valid value for ${key}`);
    }
    overrides[key] = parsed.data;
  }
  return overrides as Partial<InstanceSettingsFields>;
}

/** The named defaults written to a new database. */
export function defaultInstanceSettings(now: number): InstanceSettings {
  return {
    concurrencyPipeline: CONCURRENCY_PIPELINE,
    maxDataGB: MAX_DATA_GB,
    lowWaterFreeGB: LOW_WATER_FREE_GB,
    lowWaterFreeRatio: LOW_WATER_FREE_RATIO,
    uploadRetentionDefault: UPLOAD_RETENTION_DEFAULT,
    updatedAt: now,
  };
}

/** Writes the default row once; an existing row is left exactly as it is. Runs on every start. */
export function ensureInstanceSettings(repository: Repository, now: () => number = Date.now): InstanceSettings {
  return repository.withTransaction((scope) => {
    const existing = scope.instanceSettings.get();
    if (existing !== undefined) {
      return existing;
    }
    const created = defaultInstanceSettings(now());
    scope.instanceSettings.put(created);
    return created;
  });
}

export interface InstanceSettingsServiceOptions {
  repository: Repository;
  /** Values fixed by environment variables; they win over the database and are read-only. */
  overrides: Partial<InstanceSettingsFields>;
  /** Called after a change so waiting work can use new limits. */
  onChange?: () => void;
  now?: () => number;
}

/**
 * `GET/PATCH /api/instance-settings` and the effective values the
 * scheduler reads. Only administrators may read or change them. The one concurrency
 * setting is the number of Tasks processed at once; model requests and local heavy work
 * have no setting of their own. A lowered value applies to slots requested
 * afterwards; nothing already running is pre-empted. A stored value above its limit
 * (written before the limit existed) is read as the limit.
 */
export class InstanceSettingsService implements InstanceSettingsSource {
  private readonly options: InstanceSettingsServiceOptions;
  private readonly now: () => number;
  private cached: InstanceSettings | undefined;

  constructor(options: InstanceSettingsServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  effective(): InstanceSettings {
    this.cached ??= this.withOverrides(ensureInstanceSettings(this.options.repository, this.now));
    return this.cached;
  }

  get(principal: RequestPrincipal): InstanceSettingsDto {
    requireAdmin(principal);
    return this.toDto(this.effective());
  }

  patch(principal: RequestPrincipal, patch: InstanceSettingsPatch): InstanceSettingsDto {
    requireAdmin(principal);
    const fixed = Object.keys(patch).filter((key) => key in this.options.overrides);
    if (fixed.length > 0) {
      throw amberError("conflict", `instance settings fixed by the environment: ${fixed.join(", ")}`, {
        code: "conflict.setting_env_overridden",
      });
    }
    const stored = this.options.repository.withTransaction((scope) => {
      const current = scope.instanceSettings.get() ?? defaultInstanceSettings(this.now());
      const changes = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
      // Clamping here too lets any save write back a value stored before the limits existed.
      const next = clampConcurrency({ ...current, ...(changes as Partial<InstanceSettingsFields>), updatedAt: this.now() });
      scope.instanceSettings.put(next);
      return next;
    });
    this.cached = this.withOverrides(stored);
    this.options.onChange?.();
    return this.toDto(this.cached);
  }

  /**
   * The client's cache location, written by the cache root service only. The
   * cached effective settings are refreshed at once so the scheduler and the cache store
   * see the new root in the same tick as the commit.
   */
  updateCacheRoot(patch: { cacheRoot?: string | undefined; cacheMigration?: CacheMigrationMarker | undefined }): InstanceSettings {
    const stored = this.options.repository.withTransaction((scope) => {
      const next: InstanceSettings = { ...(scope.instanceSettings.get() ?? defaultInstanceSettings(this.now())), updatedAt: this.now() };
      // A key present with `undefined` clears the field; an absent key leaves it alone.
      if ("cacheRoot" in patch) {
        delete next.cacheRoot;
        if (patch.cacheRoot !== undefined) {
          next.cacheRoot = patch.cacheRoot;
        }
      }
      if ("cacheMigration" in patch) {
        delete next.cacheMigration;
        if (patch.cacheMigration !== undefined) {
          next.cacheMigration = patch.cacheMigration;
        }
      }
      scope.instanceSettings.put(next);
      return next;
    });
    this.cached = this.withOverrides(stored);
    return this.cached;
  }

  private withOverrides(stored: InstanceSettings): InstanceSettings {
    return clampConcurrency({ ...stored, ...this.options.overrides });
  }

  /**
   * Field by field, never a spread: the row also carries the cache root, the migration
   * marker and the credentials-reset audit time, which are server-side state the strict
   * DTO schema does not admit.
   */
  private toDto(settings: InstanceSettings): InstanceSettingsDto {
    return {
      concurrencyPipeline: settings.concurrencyPipeline,
      maxDataGB: settings.maxDataGB,
      lowWaterFreeGB: settings.lowWaterFreeGB,
      lowWaterFreeRatio: settings.lowWaterFreeRatio,
      uploadRetentionDefault: settings.uploadRetentionDefault,
      updatedAt: settings.updatedAt,
      envOverridden: INSTANCE_SETTING_KEYS.filter((key) => key in this.options.overrides),
    };
  }
}

/** Reads a concurrency stored above its limit as the limit. */
function clampConcurrency(settings: InstanceSettings): InstanceSettings {
  const clamped: InstanceSettings = { ...settings };
  for (const [key, max] of Object.entries(CONCURRENCY_LIMITS) as [keyof typeof CONCURRENCY_LIMITS, number][]) {
    clamped[key] = Math.min(clamped[key], max);
  }
  return clamped;
}

function requireAdmin(principal: RequestPrincipal): void {
  if (principal.role !== "admin") {
    throw amberError("forbidden", "instance settings require the admin role");
  }
}
