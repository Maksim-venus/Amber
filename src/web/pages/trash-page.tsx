import { RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TRASH_RETENTION_DAYS } from "../../shared/defaults.ts";
import type { TrashItemDto } from "../../shared/dto/trash.ts";
import { formatBytes } from "../../shared/units.ts";
import { appErrorOf, ConfirmDialog } from "../components/confirm-dialog.tsx";
import { ErrorView } from "../components/error-view.tsx";
import { formatDateTime, formatDuration } from "../format.ts";
import { useEmptyTrash, usePurgeTrashItem, useRestoreTrashItem, useTrashList } from "../trash/queries.ts";
import { Button } from "../ui/button.tsx";
import { EmptyState, Loading, PageHeader } from "../ui/feedback.tsx";
import { Pagination, useListPosition, usePagination } from "../ui/pagination.tsx";
import { Cover } from "./library-page.tsx";

const DAY_MS = 24 * 60 * 60 * 1000;
const NO_ITEMS: readonly TrashItemDto[] = [];

/**
 * What a row says about its purge: `expired` once the retention has run out, `lessThanDay`
 * in the last day, else the days left rounded up (a Content trashed just now has the full
 * `TRASH_RETENTION_DAYS`).
 */
export function trashCountdown(item: Pick<TrashItemDto, "purgeAt" | "expired">, now: number): "expired" | "lessThanDay" | number {
  const left = item.purgeAt - now;
  if (item.expired || left <= 0) return "expired";
  return left <= DAY_MS ? "lessThanDay" : Math.ceil(left / DAY_MS);
}

/**
 * Milliseconds until any row's countdown text changes, or `undefined` when every entry has
 * expired already: above one day the text drops each time a whole number of days is left,
 * in the last day it changes on expiry.
 */
export function nextCountdownChange(items: ReadonlyArray<Pick<TrashItemDto, "purgeAt" | "expired">>, now: number): number | undefined {
  let next: number | undefined;
  for (const item of items) {
    const left = item.purgeAt - now;
    if (item.expired || left <= 0) continue;
    const delay = left > DAY_MS ? ((left - 1) % DAY_MS) + 1 : left;
    next = next === undefined ? delay : Math.min(next, delay);
  }
  return next;
}

/** The current time, re-read when the nearest countdown changes; one timer for the whole page. */
function useCountdownClock(items: readonly TrashItemDto[]): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    // Measured from the time the rows show, so a late render cannot skip a change.
    const delay = nextCountdownChange(items, now);
    if (delay === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, now + delay - Date.now()));
    return () => clearTimeout(timer);
  }, [items, now]);
  return now;
}

type Notice = { kind: "restored"; title: string } | { kind: "partial"; count: number };

/**
 * The trash: Contents the user deleted, kept for `TRASH_RETENTION_DAYS` and
 * then purged by the server. Entries cannot be opened, only restored (until they expire) or
 * purged at once.
 */
export function TrashPage() {
  const { t } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const list = useTrashList(useListPosition("trash"));
  const pager = usePagination({
    scope: "trash",
    total: list.data?.total,
    totalStale: list.isPlaceholderData,
    onPageShown: () => {
      if (scroller.current !== null) scroller.current.scrollTop = 0;
    },
  });
  const restore = useRestoreTrashItem();
  const purge = usePurgeTrashItem();
  const emptyTrash = useEmptyTrash();
  const [purging, setPurging] = useState<TrashItemDto | undefined>(undefined);
  const [emptying, setEmptying] = useState(false);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  // The previous page's rows are never shown while the next page loads.
  const items = list.isPlaceholderData ? NO_ITEMS : (list.data?.items ?? NO_ITEMS);
  // Across all pages: what emptying the trash purges.
  const total = list.data?.total ?? 0;
  const now = useCountdownClock(items);
  const titleOf = (item: TrashItemDto): string => item.title ?? t("trash.untitled");

  return (
    <div className="flex h-full flex-col" data-testid="trash-page">
      <PageHeader
        title={t("trash.title")}
        actions={
          <Button variant="danger" data-testid="trash-empty-all" disabled={total === 0} onClick={() => setEmptying(true)}>
            <Trash2 size={14} aria-hidden="true" />
            {t("trash.emptyAll")}
          </Button>
        }
      />
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
        <p className="px-6 pt-4 text-xs text-muted">{t("trash.hint", { days: TRASH_RETENTION_DAYS })}</p>
        {notice === undefined ? null : (
          <p data-testid="trash-notice" role="status" className="mx-6 mt-3 rounded bg-accent-soft px-3 py-2 text-xs text-accent">
            {notice.kind === "restored" ? t("trash.restored", { title: notice.title }) : t("trash.emptyAllPartial", { count: notice.count })}
          </p>
        )}
        {list.isError ? (
          <div className="p-6">
            <ErrorView error={appErrorOf(list.error)} />
          </div>
        ) : list.isPending || list.isPlaceholderData || (items.length === 0 && total > 0) ? (
          // An empty page of a non-empty trash is past the end (entries went meanwhile): the
          // pager moves to the last page once it knows the total.
          <Loading />
        ) : items.length === 0 ? (
          <div data-testid="trash-empty">
            <EmptyState title={t("trash.empty")} />
          </div>
        ) : (
          <ul className="mt-3 border-t border-line">
            {items.map((item) => (
              <TrashRow
                key={item.id}
                item={item}
                now={now}
                restoring={restore.isPending && restore.variables === item.id}
                restoreError={restore.isError && restore.variables === item.id ? restore.error : undefined}
                onRestore={() => {
                  setNotice(undefined);
                  restore.mutate(item.id, { onSuccess: () => setNotice({ kind: "restored", title: titleOf(item) }) });
                }}
                onPurge={() => setPurging(item)}
              />
            ))}
          </ul>
        )}
      </div>
      <Pagination pager={pager} className="border-t border-line px-6 py-3" />
      <ConfirmDialog
        open={purging !== undefined}
        onOpenChange={(open) => (open ? undefined : setPurging(undefined))}
        title={t("trash.purgeTitle")}
        description={t("trash.purgeDescription", { title: purging === undefined ? "" : titleOf(purging) })}
        confirmLabel={t("trash.purge")}
        danger
        onConfirm={async () => {
          if (purging === undefined) return;
          setNotice(undefined);
          await purge(purging.id);
        }}
      />
      <ConfirmDialog
        open={emptying}
        onOpenChange={setEmptying}
        title={t("trash.emptyAllTitle")}
        description={t("trash.emptyAllDescription", { count: total })}
        confirmLabel={t("trash.emptyAll")}
        danger
        onConfirm={async () => {
          setNotice(undefined);
          const result = await emptyTrash();
          if (result.failed.length > 0) setNotice({ kind: "partial", count: result.failed.length });
        }}
      />
    </div>
  );
}

function TrashRow(props: {
  item: TrashItemDto;
  now: number;
  restoring: boolean;
  restoreError: unknown;
  onRestore: () => void;
  onPurge: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { item } = props;
  const countdown = trashCountdown(item, props.now);
  const expired = countdown === "expired";
  const meta = [
    t(`common.source.${item.source.kind}`),
    ...(item.durationMs === undefined ? [] : [formatDuration(item.durationMs)]),
    t("trash.deletedAt", { date: formatDateTime(item.trashedAt, i18n.language) }),
    t("trash.media", { size: formatBytes(item.mediaBytes) }),
  ].join(" · ");
  return (
    <li data-testid="trash-row" data-content-id={item.id} className="border-b border-line px-6 py-3">
      <div className="flex items-center gap-4">
        <Cover url={item.coverUrl} />
        {/* Not a link: a Content in the trash cannot be opened. */}
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-medium">{item.title ?? t("trash.untitled")}</p>
          <p className="mt-0.5 text-xs text-muted">{meta}</p>
        </div>
        <span data-testid="trash-status" className={`shrink-0 text-xs whitespace-nowrap ${expired ? "text-danger" : "text-muted"}`}>
          {expired ? t("trash.expired") : countdown === "lessThanDay" ? t("trash.lessThanDay") : t("trash.daysLeft", { days: countdown })}
        </span>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="ghost" data-testid="trash-restore" disabled={expired || props.restoring} onClick={props.onRestore}>
            <RotateCcw size={14} aria-hidden="true" />
            {t("trash.restore")}
          </Button>
          <Button size="sm" variant="ghost" className="text-danger" data-testid="trash-purge" onClick={props.onPurge}>
            <Trash2 size={14} aria-hidden="true" />
            {t("trash.purge")}
          </Button>
        </div>
      </div>
      {props.restoreError === undefined ? null : (
        <div className="mt-2">
          <ErrorView error={appErrorOf(props.restoreError)} />
        </div>
      )}
    </li>
  );
}
