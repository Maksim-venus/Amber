import { useEffect, useRef } from "react";
import { SAVE_NOTICE_DISMISS_MS } from "../shared/defaults.ts";

/**
 * Dismisses a transient notice after `SAVE_NOTICE_DISMISS_MS`. `key` names the
 * notice on screen — `undefined` while there is none — so a new notice restarts the wait and
 * removing it early (or unmounting) cancels it. The latest `onDismiss` is called.
 */
export function useAutoDismiss(key: unknown, onDismiss: () => void): void {
  const latest = useRef(onDismiss);
  latest.current = onDismiss;
  useEffect(() => {
    if (key === undefined) return undefined;
    const timer = setTimeout(() => latest.current(), SAVE_NOTICE_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [key]);
}
