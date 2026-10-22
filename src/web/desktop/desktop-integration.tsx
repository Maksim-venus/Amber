import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { resolveEndpoint } from "../api/client.ts";
import { useApi, useTaskHub } from "../api/context.tsx";
import { Link } from "react-router";
import { RELEASES_PAGE_URL } from "../../shared/app-identity.ts";
import { formatBytes } from "../../shared/units.ts";
import { requestOpenTasks } from "../shell/task-panel.tsx";
import { Button } from "../ui/button.tsx";
import { Modal } from "../ui/modal.tsx";
import { EVENT_SIDECAR_FAILED, EVENT_SIDECAR_RESTARTED, onShellEvent } from "./bridge.ts";
import { UpdateProvider, useBackupBusy, useUpdater, type UpdateController } from "./updater.ts";
import { useDesktop } from "./use-desktop.ts";

/**
 * Desktop-only wiring at the app root: following a restarted sidecar, the banner when it
 * is gone for good, external links in the system browser, window fullscreen following the
 * page, and the update prompt. Renders nothing outside the desktop client.
 */
export function DesktopIntegration(props: { updateController?: UpdateController } = {}) {
  const desktop = useDesktop();
  const failed = useSidecarRecovery(desktop);
  useExternalLinks(desktop);
  useNativeFullscreen(desktop);
  return (
    <>
      {failed ? <SidecarFailedBanner /> : null}
      {desktop ? (
        <UpdateProvider {...(props.updateController === undefined ? {} : { controller: props.updateController })}>
          <UpdatePrompt />
        </UpdateProvider>
      ) : null}
    </>
  );
}

/**
 * After the shell restarted the sidecar (new port, new token): point the client at the new
 * endpoint, reopen the task stream, and refetch every query, since nothing published while
 * the backend was down is replayed. Returns whether the shell gave up.
 */
export function useSidecarRecovery(enabled: boolean): boolean {
  const client = useApi();
  const hub = useTaskHub();
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    const unsubscribers: Array<() => void> = [];
    const keep = (unsubscribe: () => void): void => {
      if (disposed) unsubscribe();
      else unsubscribers.push(unsubscribe);
    };
    void onShellEvent(EVENT_SIDECAR_RESTARTED, () => {
      void (async () => {
        client.setEndpoint(await resolveEndpoint());
        hub.reconnect();
        setFailed(false);
        await queryClient.invalidateQueries();
      })();
    }).then(keep);
    void onShellEvent<string>(EVENT_SIDECAR_FAILED, () => setFailed(true)).then(keep);
    return () => {
      disposed = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [enabled, client, hub, queryClient]);
  return failed;
}

/** The http(s) URL an anchor click should leave the app for, if it is one. */
export function externalHref(anchor: HTMLAnchorElement, appOrigin: string): string | undefined {
  let url: URL;
  try {
    url = new URL(anchor.href, appOrigin);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return anchor.target === "_blank" || url.origin !== appOrigin ? url.href : undefined;
}

/**
 * Desktop client: http(s) links that would leave the app (new tab or another origin) open
 * in the system browser through the opener plugin; every other scheme is left alone and the
 * shell's capability allows nothing else anyway.
 */
export function useExternalLinks(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const onClick = (event: MouseEvent): void => {
      if (event.defaultPrevented || !(event.target instanceof Element)) return;
      const anchor = event.target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const href = externalHref(anchor, window.location.origin);
      if (href === undefined) return;
      event.preventDefault();
      void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(href)).catch(() => undefined);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [enabled]);
}

/**
 * Desktop client: an element entering fullscreen (the local player, or a platform iframe's
 * own fullscreen button) only fills the WebView, so the window follows it into and out of
 * fullscreen. A failed call leaves the window as it is.
 */
export function useNativeFullscreen(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const onChange = (): void => {
      const fullscreen = (document.fullscreenElement ?? null) !== null;
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().setFullscreen(fullscreen))
        .catch(() => undefined);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [enabled]);
}

function SidecarFailedBanner() {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-x-0 top-0 z-[60] bg-danger px-4 py-2 text-center text-sm text-white" role="alert" data-testid="sidecar-failed">
      {t("shell.desktop.sidecarFailed")}
    </div>
  );
}

/**
 * The bottom-right update card: one automatic check per process when the
 * preference allows it; a found version is offered, never downloaded unasked. The card
 * follows the download and the install, and explains a refused maintenance admission.
 */
function UpdatePrompt() {
  const { t } = useTranslation();
  const update = useUpdater();
  const backupBusy = useBackupBusy();
  const { controller } = update;
  useEffect(() => {
    void controller.autoCheck();
  }, [controller]);
  const visible = update.prompt && (update.status === "available" || update.status === "downloading" || update.status === "ready_to_install" || update.status === "installing" || (update.status === "failed" && update.error?.step !== "check"));
  return (
    <>
      {visible ? (
        <div className="fixed right-4 bottom-4 z-50 flex max-w-sm flex-col gap-2 rounded-lg border border-line bg-surface p-3 text-sm shadow-xl" role="status" data-testid="update-prompt">
          <p className="font-medium">{t("shell.desktop.updateFound", { version: update.version ?? "" })}</p>
          {update.notes === undefined || update.notes === "" ? null : (
            <div className="max-h-32 overflow-auto text-xs whitespace-pre-wrap text-muted" data-testid="update-notes">
              {update.notes}
            </div>
          )}
          <p className="text-xs text-muted">{t("shell.desktop.updateBackupHint")}</p>
          <UpdateProgressLine />
          {update.status === "ready_to_install" ? <p className="text-xs text-muted">{t("shell.desktop.updateDownloaded")}</p> : null}
          {update.status === "installing" ? <p className="text-xs text-muted">{t("shell.desktop.updateInstalling")}</p> : null}
          {update.status === "failed" && update.error !== undefined ? (
            <p className="text-xs text-danger" role="alert">
              {t("shell.desktop.updateFailed", { reason: update.error.message })}{" "}
              <a href={RELEASES_PAGE_URL} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline" data-testid="update-manual-download">
                {t("shell.about.update.manualDownload")}
              </a>
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Link to="/settings/backup" className="inline-flex h-7 items-center rounded-md px-2 text-xs font-medium text-accent hover:bg-sunken" data-testid="update-backup-first">
              {t("shell.desktop.updateBackupFirst")}
            </Link>
            {update.status === "available" ? (
              <Button size="sm" variant="ghost" onClick={() => controller.later()}>
                {t("shell.desktop.updateLater")}
              </Button>
            ) : null}
            {update.status === "available" ? (
              <Button size="sm" variant="primary" disabled={backupBusy} onClick={() => void controller.download()} data-testid="update-download">
                {t("shell.desktop.updateDownload")}
              </Button>
            ) : null}
            {update.status === "ready_to_install" ? (
              <Button size="sm" variant="primary" disabled={backupBusy} onClick={() => void controller.install()} data-testid="update-install">
                {t("shell.desktop.updateInstall")}
              </Button>
            ) : null}
            {update.status === "failed" ? (
              <Button size="sm" variant="primary" onClick={() => void controller.retry()} data-testid="update-retry">
                {t("shell.desktop.updateRetry")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      <UpdateBlockedDialog />
    </>
  );
}

/** Download progress of the current update, when one is downloading. */
export function UpdateProgressLine() {
  const { t } = useTranslation();
  const update = useUpdater();
  if (update.status !== "downloading" || update.progress === undefined) return null;
  const { downloaded, total } = update.progress;
  const label = total === undefined || total === 0 ? formatBytes(downloaded) : `${Math.min(100, Math.round((downloaded / total) * 100))}%`;
  return (
    <div data-testid="update-progress">
      <p className="text-xs text-muted">{t("shell.desktop.updateDownloading", { progress: label })}</p>
      {total === undefined || total === 0 ? null : (
        <progress className="h-1.5 w-full" max={total} value={Math.min(downloaded, total)} aria-label={t("shell.desktop.updateDownloading", { progress: label })} />
      )}
    </div>
  );
}

const BLOCKED_REASONS = [
  "conflict.tasks_unfinished",
  "conflict.tasks_still_running",
  "conflict.chat_inflight",
  "conflict.backup_in_progress",
  "conflict.cache_migrating",
  "conflict.starting_up",
  "conflict.maintenance",
] as const;
type BlockedReason = (typeof BLOCKED_REASONS)[number];

function isBlockedReason(code: string): code is BlockedReason {
  return (BLOCKED_REASONS as readonly string[]).includes(code);
}

/** Why the sidecar refused the maintenance admission, with the ways on: wait, cancel tasks, or give up. */
export function UpdateBlockedDialog() {
  const { t } = useTranslation();
  const update = useUpdater();
  const { controller } = update;
  const blocked = update.blocked;
  const tasks = blocked?.some((code) => code === "conflict.tasks_unfinished" || code === "conflict.tasks_still_running") === true;
  return (
    <Modal open={blocked !== undefined} onOpenChange={(open) => (open ? undefined : controller.dismissBlocked())} title={t("shell.desktop.updateBlockedTitle")}>
      <p className="mb-2 text-sm">{t("shell.desktop.updateBlockedIntro")}</p>
      <ul className="mb-4 list-disc pl-5 text-sm" data-testid="update-blocked-reasons">
        {(blocked ?? []).map((code) => (
          <li key={code}>{isBlockedReason(code) ? t(`shell.desktop.updateBlockedReason.${code}`) : t("shell.desktop.updateBlockedReason.other", { code })}</li>
        ))}
      </ul>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            controller.dismissBlocked();
            controller.later();
          }}
        >
          {t("shell.desktop.updateBlockedAbandon")}
        </Button>
        {tasks ? (
          <Button
            onClick={() => {
              controller.dismissBlocked();
              requestOpenTasks();
            }}
          >
            {t("shell.desktop.updateBlockedCancelTasks")}
          </Button>
        ) : null}
        <Button variant="primary" onClick={() => controller.dismissBlocked()}>
          {t("shell.desktop.updateBlockedWait")}
        </Button>
      </div>
    </Modal>
  );
}
