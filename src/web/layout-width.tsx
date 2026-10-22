import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";

interface SidebarWidth {
  width: number;
  setWidth: (width: number) => void;
}

/** 0 outside the shell, so a page rendered on its own lays out against the whole window. */
const SidebarWidthContext = createContext<SidebarWidth>({ width: 0, setWidth: () => undefined });

/** Holds the left column's current width, which the sidebar reports and pages lay out around. */
export function SidebarWidthProvider(props: { children: ReactNode }) {
  const [width, setWidth] = useState(0);
  return <SidebarWidthContext.Provider value={{ width, setWidth }}>{props.children}</SidebarWidthContext.Provider>;
}

/** Lets the sidebar report the width it takes, collapsed or dragged. */
export function useReportSidebarWidth(): (width: number) => void {
  return useContext(SidebarWidthContext).setWidth;
}

/*
 * While an element (the local player, a platform iframe) is fullscreen the window is as wide
 * as the screen. Following that width could cross a layout breakpoint, which renders another
 * layout tree, remounts the player and so drops it out of fullscreen; the width therefore
 * stays at its last windowed value until fullscreen ends. A resize is only read on the next
 * task, because the resize that enters fullscreen may be dispatched before
 * `document.fullscreenElement` is set; by then the fullscreen change of the same frame has
 * happened.
 */
const listeners = new Set<() => void>();
let pending: ReturnType<typeof setTimeout> | undefined;
let lastWidth: number | undefined;

function notify(): void {
  pending = undefined;
  for (const listener of listeners) listener();
}

function schedule(): void {
  if (pending !== undefined) clearTimeout(pending);
  pending = setTimeout(notify, 0);
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("resize", schedule);
    document.addEventListener("fullscreenchange", schedule);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    window.removeEventListener("resize", schedule);
    document.removeEventListener("fullscreenchange", schedule);
    if (pending !== undefined) clearTimeout(pending);
    pending = undefined;
  };
}

function windowWidth(): number {
  if (lastWidth === undefined || (pending === undefined && (document.fullscreenElement ?? null) === null)) lastWidth = window.innerWidth;
  return lastWidth;
}

/**
 * The window's inner width, updated on resize; the layout breakpoints compare against it.
 * It holds still while anything is fullscreen.
 */
export function useWindowWidth(): number {
  return useSyncExternalStore(subscribe, windowWidth);
}

/**
 * Width left for the page beside the sidebar: the window's inner width less the left
 * column, updated on window resize and whenever the sidebar is dragged or collapsed.
 */
export function useMainWidth(): number {
  const sidebar = useContext(SidebarWidthContext).width;
  return Math.max(0, useWindowWidth() - sidebar);
}
