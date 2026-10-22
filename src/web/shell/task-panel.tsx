import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "radix-ui";
import { ArrowRight, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { taskDetailDtoSchema, type TaskDto } from "../../shared/dto/task.ts";
import type { StageId } from "../../shared/enums.ts";
import { useApi, useContentEvents, useTask, useTaskHub } from "../api/context.tsx";
import { queryKeys, useInstanceSettings, useTaskHistory, useUnfinishedTasks, useVersion } from "../api/queries.ts";
import { formatDateTime, formatTime, sameLocalDay } from "../format.ts";
import { useIsServerAdmin } from "../auth/auth-gate.tsx";
import { latestStageRuns, ResendPrompt, runningStep, waitingUnits } from "../components/task-flow.tsx";
import { Button } from "../ui/button.tsx";
import { keepOpenForContextMenu, useContextMenuTarget, type MenuAction } from "../ui/context-menu.tsx";
import { EmptyState } from "../ui/feedback.tsx";

const openRequests = new EventTarget();

/** Asks the shell to open the task panel (e.g. after a scattered batch import). */
export function requestOpenTasks(): void {
  openRequests.dispatchEvent(new Event("open"));
}

/** Runs `open` whenever someone calls `requestOpenTasks`. */
export function useOpenTasksRequest(open: () => void): void {
  useEffect(() => {
    const listener = (): void => open();
    openRequests.addEventListener("open", listener);
    return () => openRequests.removeEventListener("open", listener);
  }, [open]);
}

/**
 * Stages whose success fills in a Content's title: a Content exists before its metadata is
 * known, and title and duration are always present once `source` (platform) or `media`
 * (local probe) has succeeded.
 */
const TITLE_STAGES: ReadonlySet<StageId> = new Set<StageId>(["source", "media"]);

/**
 * Keeps the task lists and content lists fresh: every task event can move a task between the
 * unfinished list and the history, a finished task changes a Content's processing status, and
 * a new Content's title arrives with its first stage.
 */
export function useTaskListRefresh(): void {
  const hub = useTaskHub();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      hub.onEvent((event) => {
        if (event.type === "task.updated" || event.type === "task.finished") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.tasksAll });
        }
        // A new Content learns its title when the `source` stage (platform) or the `media` probe
        // (local file) succeeds, long before its task ends; lists showing it are read again then.
        const titled = event.type === "stage.updated" && event.stageRun.status === "succeeded" && TITLE_STAGES.has(event.stageRun.stage);
        if (titled) {
          // Task cards read their target title from the task snapshot, so that is read again too.
          void queryClient.invalidateQueries({ queryKey: queryKeys.unfinishedTasks });
          hub.refresh(event.stageRun.taskId);
        }
        if (event.type === "task.finished" || titled) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.contentsAll });
          // Lecture lists in the left column and on collection pages carry the processing status too.
          void queryClient.invalidateQueries({ queryKey: queryKeys.collectionDetails });
        }
      }),
    [hub, queryClient],
  );
}

/** Where a task's result is shown. */
export function taskTarget(task: Pick<TaskDto, "contentId" | "collectionId">): string | undefined {
  if (task.contentId !== undefined) return `/contents/${task.contentId}`;
  if (task.collectionId !== undefined) return `/collections/${task.collectionId}`;
  return undefined;
}

/**
 * Side panel of the user's tasks, opened from the tasks entry of the left column:
 * the unfinished ones with their live state, then the finished ones as a history read
 * from the server page by page, so what ran and when stays visible across reloads.
 */
export function TaskPanel(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // A trashed, purged or restored Content takes its tasks out of (or back into) both lists;
  // the server decides which tasks are listed, so they are read again.
  const contentEvents = useContentEvents();
  useEffect(
    () =>
      contentEvents.subscribe(() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.tasksAll });
      }),
    [contentEvents, queryClient],
  );
  const { onOpenChange } = props;
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/20" />
        <Dialog.Content
          data-testid="task-panel"
          aria-describedby={undefined}
          onPointerDownOutside={keepOpenForContextMenu}
          className="fixed top-0 right-0 z-50 flex h-full w-[380px] max-w-[92vw] flex-col border-l border-line bg-surface shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <Dialog.Title className="text-base font-semibold">{t("shell.tasks.title")}</Dialog.Title>
            <Dialog.Close className="rounded p-1 text-muted hover:bg-sunken" aria-label={t("common.action.close")}>
              <X size={16} />
            </Dialog.Close>
          </div>
          <CapacityLine onNavigate={close} />
          <TaskLists onNavigate={close} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The panel body; mounted only while the panel is open, so the history is read only then. */
function TaskLists(props: { onNavigate: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const unfinished = useUnfinishedTasks();
  const history = useTaskHistory();
  // A task whose snapshot read finds it gone (its Content trashed in another tab before this
  // tab heard of it) means the lists are out of date.
  const refresh = useCallback(() => void queryClient.invalidateQueries({ queryKey: queryKeys.tasksAll }), [queryClient]);
  const active = unfinished.data?.items ?? [];
  // A task that has just finished can still be in the unfinished list until it is read again,
  // and pages read at different times may overlap; each task is shown once.
  const shown = new Set(active.map((task) => task.id));
  const finished: TaskDto[] = [];
  for (const page of history.data?.pages ?? []) {
    for (const task of page.items) {
      if (shown.has(task.id)) continue;
      shown.add(task.id);
      finished.push(task);
    }
  }
  const loading = unfinished.isPending || history.isPending;

  return (
    <div className="flex-1 overflow-auto p-3">
      {active.length === 0 && finished.length === 0 ? (
        loading ? null : <EmptyState title={t("shell.tasks.empty")} />
      ) : (
        <div className="flex flex-col gap-4">
          {active.length === 0 ? null : (
            <section data-testid="task-active" className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted">{t("shell.tasks.active")}</h3>
              <ul className="flex flex-col gap-2">
                {active.map((task) => (
                  <TaskCard key={task.id} task={task} onNavigate={props.onNavigate} onGone={refresh} />
                ))}
              </ul>
            </section>
          )}
          {finished.length === 0 ? null : (
            <section data-testid="task-history" className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted">{t("shell.tasks.history")}</h3>
              <ul className="flex flex-col gap-2">
                {finished.map((task) => (
                  <HistoryCard key={task.id} task={task} onNavigate={props.onNavigate} />
                ))}
              </ul>
              {history.hasNextPage ? (
                <Button
                  data-testid="task-history-more"
                  size="sm"
                  variant="ghost"
                  disabled={history.isFetchingNextPage}
                  onClick={() => void history.fetchNextPage()}
                >
                  {t("shell.tasks.loadMore")}
                </Button>
              ) : null}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * "At most N tasks at once · adjust", for administrators only (the local user always is one):
 * it explains why later tasks queue and leads to the setting that changes it.
 * Others never read the instance parameters, which the server would refuse anyway.
 */
function CapacityLine(props: { onNavigate: () => void }) {
  const { t } = useTranslation();
  const version = useVersion();
  const serverAdmin = useIsServerAdmin();
  const mode = version.data?.mode;
  const admin = mode === "local" || (mode === "server" && serverAdmin);
  const settings = useInstanceSettings(admin);
  if (!admin || settings.data === undefined) return null;
  const target = mode === "local" ? "/settings/storage#concurrency" : "/admin/instance#concurrency";
  return (
    <p data-testid="task-capacity" className="border-b border-line px-4 py-2 text-xs text-muted">
      {t("shell.tasks.capacity", { count: settings.data.concurrencyPipeline })} ·{" "}
      <Link to={target} onClick={props.onNavigate} className="text-accent hover:underline">
        {t("shell.tasks.adjust")}
      </Link>
    </p>
  );
}

/** `setTimeout` fires at once for delays beyond a signed 32-bit millisecond count. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * The cooldown end a queued task waits for, or `undefined` once it has passed; re-renders the
 * caller when it passes so the card falls back to "queued" without waiting for the next event.
 */
function useRetryWait(task: Pick<TaskDto, "statusProjection" | "retryNotBefore">): number | undefined {
  const [now, setNow] = useState(Date.now);
  const until = task.statusProjection === "queued" ? task.retryNotBefore : undefined;
  useEffect(() => {
    if (until === undefined || until <= now) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(until - Date.now(), MAX_TIMER_DELAY_MS));
    return () => clearTimeout(timer);
  }, [until, now]);
  return until !== undefined && until > Date.now() ? until : undefined;
}

/** Local `HH:MM`, with the date in front when it is not today. */
function formatRetryTime(epochMs: number, now: number, language: string): string {
  const at = new Date(epochMs);
  const today = new Date(now);
  const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
  return new Intl.DateTimeFormat(language, {
    ...(sameDay ? {} : { month: "numeric", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}

const TERMINAL: ReadonlySet<TaskDto["statusProjection"]> = new Set<TaskDto["statusProjection"]>(["succeeded", "failed", "cancelled"]);

/** The "view" entry of a card's context menu, leading where the task's result is shown. */
function viewEntry(label: string, target: string, onNavigate: () => void, navigate: (to: string) => unknown): MenuAction {
  return {
    id: "view",
    label,
    icon: <ArrowRight size={14} aria-hidden="true" />,
    onSelect: () => {
      onNavigate();
      void navigate(target);
    },
  };
}

function ViewLink(props: { target: string; onNavigate: () => void }) {
  const { t } = useTranslation();
  return (
    <Link to={props.target} onClick={props.onNavigate} className="inline-flex h-7 items-center rounded-md border border-line px-2 text-xs font-medium hover:bg-sunken">
      {t("shell.tasks.view")}
    </Link>
  );
}

/** An unfinished task, following its live snapshot. */
function TaskCard(props: { task: TaskDto; onNavigate: () => void; onGone: () => void }) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const hub = useTaskHub();
  const view = useTask(props.task.id);
  const { onGone } = props;
  const gone = view.gone === true;
  useEffect(() => {
    if (gone) onGone();
  }, [gone, onGone]);
  const task = view.detail ?? props.task;
  const runs = view.detail === undefined ? [] : latestStageRuns(view.detail);
  const current = runs.find((run) => run.status === "running" || run.status === "waiting_configuration" || run.status === "failed") ?? runs.find((run) => run.status === "pending");
  // The snapshot can report the end before the unfinished list is read again.
  const finished = TERMINAL.has(task.statusProjection);
  // A parked unit leaves its stage `running`; the confirmation must surface here because this
  // panel is the only view that covers every task kind.
  const waiting = view.detail === undefined ? [] : waitingUnits(view.detail);
  const waitingStage = waiting.length === 0 ? undefined : (runs.find((run) => run.id === waiting[0]?.stageRunId)?.stage ?? current?.stage);
  const step = view.detail === undefined || current?.status !== "running" ? undefined : runningStep(view.detail, current.id);
  const retryAt = useRetryWait(task);
  const cancel = useMutation({
    mutationFn: () => api.post(`/api/tasks/${encodeURIComponent(task.id)}/cancel`, taskDetailDtoSchema),
    onSettled: () => hub.refresh(task.id),
  });
  const target = taskTarget(task);
  const navigate = useNavigate();
  // The same two actions the card's buttons offer, under the same conditions.
  const menuTarget = useContextMenuTarget<HTMLLIElement>(() => {
    const entries: MenuAction[] = [];
    if (target !== undefined) entries.push(viewEntry(t("shell.tasks.view"), target, props.onNavigate, navigate));
    if (!finished) {
      entries.push({ id: "cancel-task", label: t("shell.tasks.cancel"), disabled: cancel.isPending, onSelect: () => cancel.mutate() });
    }
    return entries.length === 0 ? undefined : { kind: "object", entries };
  });
  // Out of sight until the lists, read again, drop it.
  if (gone) return null;
  return (
    <li ref={menuTarget} data-testid="task-card" className="rounded-md border border-line p-3 text-sm">
      <p className="truncate font-medium">{task.targetTitle ?? t(`common.taskKind.${task.kind}`)}</p>
      <p className="mt-0.5 text-xs text-muted">
        {t(`common.taskKind.${task.kind}`)} ·{" "}
        {finished
          ? t(`common.status.${task.statusProjection}`)
          : waiting.length > 0 && waitingStage !== undefined
            ? t("shell.tasks.waitingUser", { stage: t(`common.stage.${waitingStage}`) })
            : retryAt !== undefined
              ? t(task.waitingStep === "awaitResult" ? "shell.tasks.awaitingResult" : "shell.tasks.retryWaiting", {
                  time: formatRetryTime(retryAt, Date.now(), i18n.language),
                })
              : // A queued task has not started any stage yet; naming one would suggest it runs.
                task.statusProjection === "queued" || current === undefined
                ? t(`common.status.${task.statusProjection}`)
                : step === undefined
                  ? t("shell.tasks.currentStage", { stage: t(`common.stage.${current.stage}`) })
                  : t("shell.tasks.currentStep", { stage: t(`common.stage.${current.stage}`), step: t(`shell.flow.step.${step}`) })}
      </p>
      {!finished && current?.status === "running" && task.statusProjection === "running" ? (
        <div data-testid="task-progress" className="mt-2 h-1 overflow-hidden rounded bg-sunken">
          <div className="h-full bg-accent" style={{ width: `${Math.round(current.progress * 100)}%` }} />
        </div>
      ) : null}
      {!finished && waiting.length > 0 ? <ResendPrompt taskId={task.id} units={waiting} /> : null}
      <div className="mt-2 flex gap-2">
        {finished ? null : (
          <Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            {t("shell.tasks.cancel")}
          </Button>
        )}
        {target === undefined ? null : <ViewLink target={target} onNavigate={props.onNavigate} />}
      </div>
    </li>
  );
}

/**
 * A finished task from the history: what it was, how it ended and when it ran. It shows the
 * listed fields only and reads no snapshot, so a long history costs one request per page.
 */
function HistoryCard(props: { task: TaskDto; onNavigate: () => void }) {
  const { t, i18n } = useTranslation();
  const { task } = props;
  const target = taskTarget(task);
  const navigate = useNavigate();
  const menuTarget = useContextMenuTarget<HTMLLIElement>(() =>
    target === undefined ? undefined : { kind: "object", entries: [viewEntry(t("shell.tasks.view"), target, props.onNavigate, navigate)] },
  );
  return (
    <li ref={menuTarget} data-testid="task-history-card" className="rounded-md border border-line p-3 text-sm">
      <p className="truncate font-medium">{task.targetTitle ?? t(`common.taskKind.${task.kind}`)}</p>
      <p className="mt-0.5 text-xs text-muted">
        {t(`common.taskKind.${task.kind}`)} · {t(`common.status.${task.statusProjection}`)}
      </p>
      <p className="mt-0.5 text-xs text-muted">
        {t("shell.tasks.startedAt", { time: formatDateTime(task.createdAt, i18n.language) })}
        {task.finishedAt === undefined
          ? null
          : ` · ${t("shell.tasks.finishedAt", {
              // An end on the start's date repeats only the time.
              time: sameLocalDay(task.createdAt, task.finishedAt) ? formatTime(task.finishedAt, i18n.language) : formatDateTime(task.finishedAt, i18n.language),
            })}`}
      </p>
      {target === undefined ? null : (
        <div className="mt-2 flex gap-2">
          <ViewLink target={target} onNavigate={props.onNavigate} />
        </div>
      )}
    </li>
  );
}
