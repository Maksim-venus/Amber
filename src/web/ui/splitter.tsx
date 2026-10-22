import { useRef, type PointerEvent } from "react";

/**
 * Native pointer-driven vertical splitter. Reports horizontal pointer
 * movement; the owner turns it into a column width and clamps it. A double click asks for
 * the default width back. `className` replaces the default look, e.g. for a handle laid
 * over a column's edge.
 */
export function Splitter(props: { label: string; onResize: (deltaPx: number) => void; onEnd: () => void; onReset?: () => void; testId?: string; className?: string }) {
  const start = useRef<number | undefined>(undefined);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    start.current = event.clientX;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (start.current === undefined) return;
    props.onResize(event.clientX - start.current);
    start.current = event.clientX;
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    if (start.current === undefined) return;
    start.current = undefined;
    event.currentTarget.releasePointerCapture(event.pointerId);
    props.onEnd();
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      title={props.label}
      className={`cursor-col-resize ${props.className ?? "w-1.5 shrink-0 bg-line/40 hover:bg-accent/40"}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={props.onReset}
      data-testid={props.testId}
    />
  );
}
