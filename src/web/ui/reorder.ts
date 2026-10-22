/** A copy of `list` with the element at `from` moved to `to` (both clamped to the list). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length) {
    return next;
  }
  const target = Math.max(0, Math.min(next.length - 1, to));
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved as T);
  return next;
}

/** Index of the row whose vertical midpoint lies below `y`; the last index when none does. */
export function dropIndex(y: number, rows: ReadonlyArray<{ top: number; height: number }>): number {
  const index = rows.findIndex((row) => y < row.top + row.height / 2);
  return index === -1 ? Math.max(0, rows.length - 1) : index;
}
