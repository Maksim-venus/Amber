import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { useCallback, useEffect, useImperativeHandle, useRef, type ReactNode, type Ref } from "react";

/** Below this many rows everything renders; long transcripts switch to windowing. */
const VIRTUALIZE_FROM_ROWS = 150;

/** Imperative scrolling for controls outside the list (a chapter outline, jump-to-end buttons). */
export interface VirtualRowsHandle {
  /** `start` puts the row at the top of the list; `center` (the default) centres it. */
  scrollToIndex(index: number, align?: "start" | "center"): void;
  scrollToTop(): void;
  scrollToBottom(): void;
}

/**
 * A scrolling list that windows long content (a 5-hour lecture has thousands of sentences)
 * and scrolls `scrollToIndex` into view whenever it changes.
 */
export function VirtualRows<T>(props: {
  items: readonly T[];
  keyOf: (item: T) => string;
  render: (item: T, index: number) => ReactNode;
  estimateSize: number;
  scrollToIndex?: number | undefined;
  /**
   * A row kept mounted even when it scrolls out of the window, so a drag selection that
   * started in it keeps its anchor node while the list auto-scrolls.
   */
  pinnedIndex?: number | undefined;
  className?: string;
  testId?: string;
  ref?: Ref<VirtualRowsHandle> | undefined;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const windowed = props.items.length >= VIRTUALIZE_FROM_ROWS;
  const pinned = props.pinnedIndex;
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (pinned === undefined || pinned < 0 || pinned >= range.count || indexes.includes(pinned)) return indexes;
      return [...indexes, pinned].sort((a, b) => a - b);
    },
    [pinned],
  );
  const virtualizer = useVirtualizer({
    count: windowed ? props.items.length : 0,
    getScrollElement: () => parent.current,
    estimateSize: () => props.estimateSize,
    overscan: 8,
    rangeExtractor,
  });
  const target = props.scrollToIndex;

  // Windowed rows go through the virtualizer: its scroll methods keep correcting the target
  // as rows are measured, so a jump lands on the real position rather than the estimate.
  useImperativeHandle(
    props.ref,
    () => ({
      scrollToIndex(index, align = "center") {
        if (windowed) {
          virtualizer.scrollToIndex(index, { align });
          return;
        }
        const element = parent.current?.querySelector(`[data-row-index="${index}"]`);
        if (!(element instanceof HTMLElement) || parent.current === null) return;
        if (align === "start") {
          // Only the list scrolls; scrollIntoView would also scroll every scrollable ancestor.
          parent.current.scrollTop += element.getBoundingClientRect().top - parent.current.getBoundingClientRect().top;
        } else if (typeof element.scrollIntoView === "function") {
          element.scrollIntoView({ block: "center" });
        }
      },
      scrollToTop() {
        if (windowed) virtualizer.scrollToOffset(0);
        else if (parent.current !== null) parent.current.scrollTop = 0;
      },
      scrollToBottom() {
        if (windowed) virtualizer.scrollToEnd();
        else if (parent.current !== null) parent.current.scrollTop = parent.current.scrollHeight;
      },
    }),
    [virtualizer, windowed],
  );

  useEffect(() => {
    if (target === undefined || target < 0) return;
    if (windowed) {
      virtualizer.scrollToIndex(target, { align: "center" });
      return;
    }
    const element = parent.current?.querySelector(`[data-row-index="${target}"]`);
    if (element instanceof HTMLElement && typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ block: "center" });
    }
  }, [target, windowed, virtualizer]);

  return (
    <div ref={parent} className={`overflow-auto ${props.className ?? ""}`} data-testid={props.testId}>
      {windowed ? (
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => {
            const item = props.items[row.index] as T;
            return (
              <div
                key={props.keyOf(item)}
                ref={virtualizer.measureElement}
                data-index={row.index}
                data-row-index={row.index}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                {props.render(item, row.index)}
              </div>
            );
          })}
        </div>
      ) : (
        props.items.map((item, index) => (
          <div key={props.keyOf(item)} data-row-index={index}>
            {props.render(item, index)}
          </div>
        ))
      )}
    </div>
  );
}
