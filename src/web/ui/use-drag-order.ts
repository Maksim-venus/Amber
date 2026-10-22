import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { dropIndex, moveItem } from "./reorder.ts";

/** Props spread onto a row's drag handle. */
export interface DragHandleProps {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}

/**
 * Reordering a vertical list by its rows' handles: native pointer events (no drag-and-drop
 * library) and the arrow keys on a focused handle. The order follows `ids`
 * whenever no gesture is in progress; `onCommit` gets the complete new order once a drag
 * ends or a key moves a row, and only when it differs from `ids`.
 */
export function useDragOrder(ids: readonly string[], onCommit: (order: string[]) => void) {
  const [order, setOrder] = useState<string[]>(() => [...ids]);
  const [dragging, setDragging] = useState<string | undefined>(undefined);
  const rows = useRef(new Map<string, HTMLElement>());
  const source = ids.join("\u0000");

  useEffect(() => {
    if (dragging === undefined) {
      setOrder(source === "" ? [] : source.split("\u0000"));
    }
  }, [source, dragging]);

  const commit = (next: string[]): void => {
    if (next.join("\u0000") !== source) {
      onCommit(next);
    }
  };

  const rowRef =
    (id: string) =>
    (element: HTMLElement | null): void => {
      if (element === null) rows.current.delete(id);
      else rows.current.set(id, element);
    };

  const handleProps = (id: string): DragHandleProps => ({
    onPointerDown: (event) => {
      // Only the primary button drags: a right click opens the context menu instead.
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(id);
    },
    onPointerMove: (event) => {
      if (dragging === undefined) return;
      const rects = order.map((rowId) => rows.current.get(rowId)?.getBoundingClientRect() ?? { top: 0, height: 0 });
      const from = order.indexOf(dragging);
      const to = dropIndex(event.clientY, rects);
      if (from !== to) setOrder(moveItem(order, from, to));
    },
    onPointerUp: () => {
      if (dragging !== undefined) {
        setDragging(undefined);
        commit(order);
      }
    },
    onPointerCancel: () => {
      if (dragging !== undefined) {
        setDragging(undefined);
        commit(order);
      }
    },
    onKeyDown: (event) => {
      const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
      if (delta === 0) return;
      event.preventDefault();
      const from = order.indexOf(id);
      const next = moveItem(order, from, from + delta);
      setOrder(next);
      commit(next);
    },
  });

  return { order, dragging, rowRef, handleProps };
}
