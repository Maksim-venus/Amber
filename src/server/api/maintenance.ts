import type { FastifyInstance } from "fastify";
import { UPDATE_INSTALL_MAINTENANCE_TTL_MS } from "../../shared/defaults.ts";
import type { MaintenanceDto, SystemActivityDto } from "../../shared/dto/backup.ts";
import { amberError, appError } from "../domain/errors.ts";
import type { CacheGate, Release } from "../pipeline/cache-gate.ts";
import { gateConflict } from "../pipeline/gate-conflict.ts";
import { httpStatusOf } from "./errors.ts";

/** The resource whose DELETE ends maintenance; it stays reachable while everything else is refused. */
export const MAINTENANCE_ROUTE = "/api/system/maintenance";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface MaintenanceOptions {
  gate: Pick<CacheGate, "tryExclusive" | "exclusiveReason">;
  unfinishedTasks: () => number;
  chatInflight: () => boolean;
  backupExportActive: () => boolean;
  now?: () => number;
  ttlMs?: number;
}

/**
 * The maintenance state entered before an update install. Admission runs in
 * one synchronous turn: it takes the exclusive cache lease (so the scheduler starts no Task
 * driver), then requires no unfinished Task, no streaming chat answer and no backup export,
 * and only then arms. While armed every changing `/api` request is refused with
 * `conflict.maintenance`; the state ends on `DELETE`, or by itself after its TTL, and either
 * way gives the lease back.
 */
export class Maintenance {
  private readonly options: MaintenanceOptions;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private release: Release | undefined;
  private until = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: MaintenanceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? UPDATE_INSTALL_MAINTENANCE_TTL_MS;
  }

  /** Whether the state is armed; an expired one is ended here as well as by its timer. */
  active(): boolean {
    if (this.release !== undefined && this.now() >= this.until) {
      this.disarm();
    }
    return this.release !== undefined;
  }

  /** `POST /system/maintenance`: arms or throws the first condition that fails, leaving nothing taken. */
  arm(): MaintenanceDto {
    if (this.active()) {
      throw amberError("conflict", "already in maintenance", { code: "conflict.maintenance" });
    }
    const release = this.options.gate.tryExclusive("update_install");
    if (release === undefined) {
      if (this.options.gate.exclusiveReason() !== undefined) {
        throw gateConflict(this.options.gate);
      }
      throw amberError("conflict", "tasks hold the cache", { code: "conflict.tasks_still_running" });
    }
    let refusal: ReturnType<typeof amberError> | undefined;
    if (this.options.unfinishedTasks() > 0) {
      refusal = amberError("conflict", "tasks are unfinished", { code: "conflict.tasks_unfinished" });
    } else if (this.options.chatInflight()) {
      refusal = amberError("conflict", "a chat answer is streaming", { code: "conflict.chat_inflight" });
    } else if (this.options.backupExportActive()) {
      refusal = amberError("conflict", "a backup export is running", { code: "conflict.backup_in_progress" });
    }
    if (refusal !== undefined) {
      release();
      throw refusal;
    }
    this.release = release;
    this.until = this.now() + this.ttlMs;
    this.timer = setTimeout(() => this.disarm(), this.ttlMs);
    this.timer.unref();
    return { until: this.until };
  }

  /** `DELETE /system/maintenance`; harmless when not armed. */
  disarm(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const release = this.release;
    this.release = undefined;
    release?.();
  }

  /** `GET /system/activity`: for display only. */
  activity(): SystemActivityDto {
    return {
      unfinishedTasks: this.options.unfinishedTasks(),
      chatInflight: this.options.chatInflight(),
      backupExport: this.options.backupExportActive(),
    };
  }
}

/**
 * Refuses changing `/api` requests while maintenance is armed. Runs after authentication, so
 * an unauthenticated caller still learns nothing; outside maintenance it is one check.
 */
export function installMaintenanceGuard(app: FastifyInstance, maintenance: Pick<Maintenance, "active">): void {
  app.addHook("onRequest", async (request, reply) => {
    if (READ_METHODS.has(request.method) || !maintenance.active()) {
      return;
    }
    const path = request.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/")) {
      return;
    }
    if (request.method === "DELETE" && request.routeOptions.url === MAINTENANCE_ROUTE) {
      return;
    }
    const error = appError("conflict", { code: "conflict.maintenance" });
    await reply.code(httpStatusOf(error)).send({ error });
  });
}
