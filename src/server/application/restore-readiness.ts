import { REPLACEABLE_SETTINGS, type ReplaceableSetting } from "../../shared/backup.ts";
import type { RestoreReadinessDto } from "../../shared/dto/backup.ts";
import type { InstanceSettings, UserSettings } from "../domain/runtime-support.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { BackupStore } from "../ports/backup.ts";
import type { Repository } from "../ports/repository.ts";
import { defaultInstanceSettings } from "./instance-settings.ts";
import { defaultSettings } from "./settings.ts";

export interface RestoreReadinessServiceOptions {
  repository: Repository;
  store: Pick<BackupStore, "nonEmptyCategories">;
}

/** The user-level settings a restore replaces that differ from what a fresh install has. */
function changedUserSettings(settings: UserSettings | undefined): ReplaceableSetting[] {
  if (settings === undefined) {
    return [];
  }
  const fresh = defaultSettings(settings.userId, 0);
  const changed: ReplaceableSetting[] = [];
  if (settings.theme !== fresh.theme) changed.push("appearance");
  if (settings.language !== fresh.language || settings.defaultOutputLanguage !== undefined) changed.push("language");
  if (Object.keys(settings.shortcuts).length > 0) changed.push("shortcuts");
  if (
    settings.chatModelRef !== undefined ||
    settings.defaultModelRef !== undefined ||
    settings.defaultAsrModelRef !== undefined ||
    settings.defaultSummaryTemplateId !== undefined
  ) {
    changed.push("model_refs");
  }
  return changed;
}

/** The instance-level settings a restore replaces that differ from the named defaults (environment overrides aside). */
function changedInstanceSettings(settings: InstanceSettings | undefined): ReplaceableSetting[] {
  if (settings === undefined) {
    return [];
  }
  const fresh = defaultInstanceSettings(0);
  const changed: ReplaceableSetting[] = [];
  if (settings.concurrencyPipeline !== fresh.concurrencyPipeline) changed.push("task_concurrency");
  if (
    settings.maxDataGB !== fresh.maxDataGB ||
    settings.lowWaterFreeGB !== fresh.lowWaterFreeGB ||
    settings.lowWaterFreeRatio !== fresh.lowWaterFreeRatio ||
    settings.uploadRetentionDefault !== fresh.uploadRetentionDefault
  ) {
    changed.push("disk");
  }
  return changed;
}

/**
 * `GET /backup/restore-readiness`: whether this installation is fresh
 * enough to restore into, what it already holds if not, and which of its settings the
 * restore would replace. The restore command repeats the fresh check itself; this answer
 * only drives the restore card.
 */
export class RestoreReadinessService {
  private readonly options: RestoreReadinessServiceOptions;

  constructor(options: RestoreReadinessServiceOptions) {
    this.options = options;
  }

  get(principal: RequestPrincipal): RestoreReadinessDto {
    const nonEmpty = this.options.store.nonEmptyCategories();
    const changed = this.options.repository.withTransaction((scope) => [
      ...changedUserSettings(scope.userSettings.get(principal.userId)),
      ...changedInstanceSettings(scope.instanceSettings.get()),
    ]);
    return { fresh: nonEmpty.length === 0, nonEmpty, willReplace: REPLACEABLE_SETTINGS.filter((setting) => changed.includes(setting)) };
  }
}
