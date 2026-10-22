import { GripVertical } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import type { CollectionItemDto } from "../../../shared/dto/collection.ts";
import { actionTarget, type ContentActions } from "../../components/use-content-actions.tsx";
import { formatDuration } from "../../format.ts";
import { listLoopState } from "../../player/list-loop.ts";
import { Cover, StatusBadge } from "../library-page.tsx";
import { useContextMenuTarget } from "../../ui/context-menu.tsx";
import { useDragOrder } from "../../ui/use-drag-order.ts";

/**
 * Lectures of one page in collection order. `startIndex` is the position of the first row
 * in the whole collection, so a lecture keeps its course number on every page. Nothing here
 * moves: reordering happens in `ReorderList`, which always shows every lecture. A right
 * click on a row offers the Content's actions; leaving the collection goes through their
 * collection membership dialog, so a row has no removal control of its own.
 */
export function ItemList(props: {
  items: readonly CollectionItemDto[];
  startIndex: number;
  /** The Content actions of the page, which renders their dialogs. */
  actions: ContentActions;
}) {
  const menuRef = useItemMenu(props.items, props.actions);
  return (
    <ol ref={menuRef} className="divide-y divide-line rounded-lg border border-line">
      {props.items.map((item, index) => (
        <ItemRow key={item.id} item={item} number={props.startIndex + index + 1} />
      ))}
    </ol>
  );
}

/**
 * The draft order of all lectures while the user rearranges them. Moving uses native
 * pointer events on the handle (no drag-and-drop library) and arrow keys on a
 * focused handle; every finished move hands the complete draft to `onChange` and nothing is
 * sent until the page saves it. Only the primary button drags, so a right click on the
 * handle opens the menu without starting a drag.
 */
export function ReorderList(props: {
  items: readonly CollectionItemDto[];
  order: readonly string[];
  onChange: (order: string[]) => void;
  /** The Content actions of the page, which renders their dialogs. */
  actions: ContentActions;
}) {
  const { t } = useTranslation();
  const { order, dragging, rowRef, handleProps } = useDragOrder(props.order, props.onChange);
  const byId = new Map(props.items.map((item) => [item.id, item]));
  const menuRef = useItemMenu(props.items, props.actions);
  return (
    <ol ref={menuRef} className="divide-y divide-line rounded-lg border border-line">
      {order.map((id, index) => {
        const item = byId.get(id);
        if (item === undefined) {
          return null;
        }
        return (
          <ItemRow
            key={id}
            item={item}
            number={index + 1}
            rowRef={rowRef(id)}
            dragging={dragging === id}
            handle={
              <button
                type="button"
                className="cursor-grab touch-none rounded p-1 text-muted hover:bg-sunken"
                aria-label={`${t("library.collection.dragHandle")} · ${item.title ?? t("library.untitled")}`}
                {...handleProps(id)}
              >
                <GripVertical size={14} />
              </button>
            }
          />
        );
      })}
    </ol>
  );
}

/** The right-click menu of a lecture row, resolved through the row's `data-item-id`. */
function useItemMenu(items: readonly CollectionItemDto[], actions: ContentActions) {
  return useContextMenuTarget<HTMLOListElement>((hit) => {
    const itemId = hit.target.closest<HTMLElement>("[data-item-id]")?.dataset["itemId"];
    const item = items.find((candidate) => candidate.id === itemId);
    if (item === undefined) return undefined;
    const target = actionTarget({ id: item.contentId, title: item.title, pinnedAt: item.pinnedAt, sourceUrl: item.sourceUrl });
    return actions.menu(target, hit);
  });
}

function ItemRow(props: {
  item: CollectionItemDto;
  /** 1-based position in the whole collection. */
  number: number;
  handle?: ReactNode;
  rowRef?: (element: HTMLElement | null) => void;
  dragging?: boolean;
}) {
  const { t } = useTranslation();
  // The collection page's own id: a lecture opened from here loops through this collection.
  const { id: collectionId } = useParams();
  const { item } = props;
  return (
    <li
      ref={props.rowRef}
      className={`flex items-center gap-3 px-3 py-2 ${props.dragging === true ? "bg-accent-soft" : "bg-surface"}`}
      data-testid="collection-item"
      data-item-id={item.id}
    >
      {props.handle}
      <span className="w-14 shrink-0 text-xs text-muted">{t("library.collection.lecture", { n: props.number })}</span>
      <Cover url={item.coverUrl} className="h-10 w-16" />
      <Link to={`/contents/${item.contentId}`} state={listLoopState(collectionId === undefined ? {} : { collectionId })} className="min-w-0 flex-1 truncate text-sm hover:underline">
        {item.title ?? t("library.untitled")}
      </Link>
      <span className="font-mono text-xs text-muted">{item.durationMs === undefined ? "" : formatDuration(item.durationMs)}</span>
      <StatusBadge status={item.processingStatus} />
    </li>
  );
}
