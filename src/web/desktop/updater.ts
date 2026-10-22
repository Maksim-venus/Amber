import { createContext, createElement, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { z } from "zod";
import { UPDATE_CHECK_TIMEOUT_MS } from "../../shared/defaults.ts";
import { maintenanceDtoSchema } from "../../shared/dto/backup.ts";
import { ApiError, type ApiClient } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { beginUpdateInstall, endUpdateInstall } from "./bridge.ts";

/**
 * The desktop client's update controller: one per process, shared by
 * the prompt card and the about dialog. Check, download and install never overlap; nothing
 * is downloaded before the user asks; installing first takes the sidecar's maintenance
 * admission, then registers with the shell, then hands over to the installer, which ends
 * the app on Windows. The app never relaunches itself; the installer starts the new version
 * once it has finished (the updater's default restart-after-install).
 */

export const UPDATE_STATUSES = ["idle", "checking", "up_to_date", "available", "downloading", "ready_to_install", "installing", "failed"] as const;
export type UpdateStatus = (typeof UPDATE_STATUSES)[number];

export type BackupWork = "export" | "restore";

/** Which step failed; a retry repeats it. */
export type UpdateStep = "check" | "download" | "install";

export interface UpdateState {
  status: UpdateStatus;
  /** The version the feed announces, once a check found one. */
  version?: string;
  /** The release notes, rendered as plain text only. */
  notes?: string;
  /** Bytes downloaded so far and the total when the server sent one. */
  progress?: { downloaded: number; total?: number };
  /** The failed step and why: an AppError code when the sidecar refused, else the updater's message. */
  error?: { step: UpdateStep; message: string; code?: string };
  /** Why the maintenance admission was refused (`conflict.*` codes); the download stays ready to install. */
  blocked?: string[];
  /** Whether the bottom-right card shows: set by an automatic check, cleared by 「稍后」. */
  prompt: boolean;
  /** Whether the last finished check was the user's own. */
  manual: boolean;
}

/** The part of a found update the controller uses (the updater plugin's `Update`). */
export interface UpdateHandle {
  version: string;
  body?: string;
  download(onEvent?: (event: UpdateDownloadEvent) => void): Promise<void>;
  install(): Promise<void>;
  close?(): Promise<void>;
}

export type UpdateDownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

/** What the controller talks to; replaced in tests. */
export interface UpdaterDeps {
  check(options: { timeout: number }): Promise<UpdateHandle | null>;
  /** `POST /api/system/maintenance`; rejects with the sidecar's ApiError when refused. */
  requestMaintenance(): Promise<void>;
  /** `DELETE /api/system/maintenance`. */
  releaseMaintenance(): Promise<void>;
  beginUpdateInstall(): Promise<void>;
  endUpdateInstall(): Promise<void>;
}

/** Device-level preference 「启动时自动检查更新」; on unless switched off. Not carried by backups. */
export const AUTO_CHECK_KEY = "amber.updates.autoCheck";

export function autoCheckEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_CHECK_KEY) !== "0";
  } catch {
    return true;
  }
}

/** The maintenance admission's refusal, as the codes the install dialog explains. */
function refusalCodes(error: unknown): string[] | undefined {
  if (error instanceof ApiError && error.status === 409) {
    return [error.error.code];
  }
  return undefined;
}

function messageOf(error: unknown): { message: string; code?: string } {
  if (error instanceof ApiError) {
    return { message: error.error.userMessage, code: error.error.code };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

export class UpdateController {
  private state: UpdateState = { status: "idle", prompt: false, manual: false };
  private readonly listeners = new Set<() => void>();
  private deps: UpdaterDeps | undefined;
  private update: UpdateHandle | undefined;
  private busy = false;
  /** One automatic check per process: remounts and sidecar restarts never repeat it. */
  private autoChecked = false;
  /** An automatic check asked for before the dependencies arrived; it runs once they do. */
  private autoCheckPending = false;
  /** The version the user postponed with 「稍后」, in memory only: a restart asks again. */
  private deferredVersion: string | undefined;
  /** Backup work in progress: an install waits for it, and export and restore exclude each other. */
  private readonly backupWork = new Set<BackupWork>();

  constructor(deps?: UpdaterDeps) {
    this.deps = deps;
  }

  /** Supplies the dependencies once the API client exists; earlier calls do nothing. */
  configure(deps: UpdaterDeps): void {
    this.deps = deps;
    if (this.autoCheckPending) {
      this.autoCheckPending = false;
      void this.autoCheck();
    }
  }

  isConfigured(): boolean {
    return this.deps !== undefined;
  }

  getState = (): UpdateState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Merges `next`; a key set to `undefined` is removed. */
  private set(next: { [K in keyof UpdateState]?: UpdateState[K] | undefined }): void {
    const merged: Record<string, unknown> = { ...this.state, ...next };
    for (const key of Object.keys(merged)) {
      if (merged[key] === undefined) delete merged[key];
    }
    this.state = merged as unknown as UpdateState;
    for (const listener of this.listeners) listener();
  }

  /** Whether a step is running; the backup section disables export and restore meanwhile. */
  isBusy(): boolean {
    return this.state.status === "downloading" || this.state.status === "installing";
  }

  setBackupBusy(work: BackupWork, busy: boolean): void {
    if (busy === this.backupWork.has(work)) return;
    if (busy) this.backupWork.add(work);
    else this.backupWork.delete(work);
    for (const listener of this.listeners) listener();
  }

  /** Whether `work` (or, without it, any backup work) is running. */
  isBackupBusy(work?: BackupWork): boolean {
    return work === undefined ? this.backupWork.size > 0 : this.backupWork.has(work);
  }

  /** The start-up check: at most once per process, and only while the preference is on. */
  async autoCheck(): Promise<void> {
    if (this.autoChecked || !autoCheckEnabled()) {
      return;
    }
    if (this.deps === undefined) {
      this.autoCheckPending = true;
      return;
    }
    this.autoChecked = true;
    await this.check({ manual: false });
  }

  /**
   * Asks the feed. A manual check shows its result in the about dialog only; an automatic one
   * raises the card for a version the user has not postponed. A failed automatic check stays
   * silent and is not a postponement.
   */
  async check(options: { manual: boolean }): Promise<void> {
    const deps = this.deps;
    if (deps === undefined || this.busy || this.isBusy() || this.state.status === "ready_to_install") {
      return;
    }
    this.busy = true;
    this.set({ status: "checking", manual: options.manual, blocked: undefined, error: undefined });
    try {
      const found = await deps.check({ timeout: UPDATE_CHECK_TIMEOUT_MS });
      if (found === null) {
        this.update = undefined;
        this.set({ status: "up_to_date", version: undefined, notes: undefined, prompt: false });
        return;
      }
      const previous = this.update;
      this.update = found;
      if (previous !== undefined && previous !== found) void previous.close?.().catch(() => undefined);
      const prompt = options.manual ? this.state.prompt && found.version === this.state.version : found.version !== this.deferredVersion;
      this.set({ status: "available", version: found.version, notes: found.body, prompt });
    } catch (error) {
      this.set({ status: "failed", error: { step: "check", ...messageOf(error) }, prompt: false });
    } finally {
      this.busy = false;
    }
  }

  /** 「稍后」: hides the card for this version until the app restarts. */
  later(): void {
    this.deferredVersion = this.state.version;
    this.set({ prompt: false });
  }

  /** Downloads and verifies the found update; installing is a separate step. */
  async download(): Promise<void> {
    const update = this.update;
    if (update === undefined || this.busy || (this.state.status !== "available" && !(this.state.status === "failed" && this.state.error?.step === "download"))) {
      return;
    }
    this.busy = true;
    let downloaded = 0;
    let total: number | undefined;
    this.set({ status: "downloading", progress: { downloaded: 0 }, error: undefined });
    try {
      await update.download((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
        }
        this.set({ progress: total === undefined ? { downloaded } : { downloaded, total } });
      });
      this.set({ status: "ready_to_install" });
    } catch (error) {
      this.set({ status: "failed", error: { step: "download", ...messageOf(error) } });
    } finally {
      this.busy = false;
    }
  }

  /**
   * Maintenance admission → shell registration → installer. A refused admission keeps the
   * download ready and lists the reasons; any later failure releases both again.
   */
  async install(): Promise<void> {
    const deps = this.deps;
    const update = this.update;
    const retrying = this.state.status === "failed" && this.state.error?.step === "install";
    if (deps === undefined || update === undefined || this.busy || this.backupWork.size > 0 || (this.state.status !== "ready_to_install" && !retrying)) {
      return;
    }
    this.busy = true;
    this.set({ status: "installing", blocked: undefined, error: undefined });
    try {
      try {
        await deps.requestMaintenance();
      } catch (error) {
        const codes = refusalCodes(error);
        if (codes !== undefined) {
          this.set({ status: "ready_to_install", blocked: codes });
        } else {
          this.set({ status: "failed", error: { step: "install", ...messageOf(error) } });
        }
        return;
      }
      let registered = false;
      try {
        await deps.beginUpdateInstall();
        registered = true;
        // On Windows the installer takes over and the process ends here.
        await update.install();
      } catch (error) {
        if (registered) await deps.endUpdateInstall().catch(() => undefined);
        await deps.releaseMaintenance().catch(() => undefined);
        this.set({ status: "failed", error: { step: "install", ...messageOf(error) } });
      }
    } finally {
      this.busy = false;
    }
  }

  /** Abandons an install the admission refused: the download stays, nothing else is held. */
  dismissBlocked(): void {
    this.set({ blocked: undefined });
  }

  /** Repeats the failed step. */
  async retry(): Promise<void> {
    const step = this.state.error?.step;
    if (this.state.status !== "failed" || step === undefined) {
      return;
    }
    if (step === "check") await this.check({ manual: this.state.manual });
    else if (step === "download") await this.download();
    else await this.install();
  }
}

/** The process-wide controller. */
export const updateController = new UpdateController();

/** The real dependencies over the updater plugin, the shell bridge and the sidecar. */
export function defaultUpdaterDeps(client: ApiClient): UpdaterDeps {
  return {
    check: async (options) => {
      const { check } = await import("@tauri-apps/plugin-updater");
      return check(options);
    },
    requestMaintenance: async () => {
      await client.post("/api/system/maintenance", maintenanceDtoSchema, { body: { reason: "update_install" } });
    },
    releaseMaintenance: async () => {
      await client.delete("/api/system/maintenance", z.undefined());
    },
    beginUpdateInstall,
    endUpdateInstall,
  };
}

const UpdaterContext = createContext<UpdateController>(updateController);

/** Wires the process-wide controller to the current API client (re-pointed in place on sidecar restarts). */
export function UpdateProvider(props: { children: ReactNode; controller?: UpdateController }) {
  const client = useApi();
  const controller = props.controller ?? updateController;
  useEffect(() => {
    if (controller === updateController || !controller.isConfigured()) controller.configure(defaultUpdaterDeps(client));
  }, [client, controller]);
  return createElement(UpdaterContext.Provider, { value: controller }, props.children);
}

export function useUpdateController(): UpdateController {
  return useContext(UpdaterContext);
}

/** The controller's state, re-rendering on every change. */
export function useUpdater(): UpdateState & { controller: UpdateController } {
  const controller = useUpdateController();
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  return { ...state, controller };
}

/** Whether backup work (`work`, or any) is running, re-rendering on change. */
export function useBackupBusy(work?: BackupWork): boolean {
  const controller = useUpdateController();
  return useSyncExternalStore(controller.subscribe, () => controller.isBackupBusy(work));
}
