import { useQuery } from "@tanstack/react-query";
import { useApi } from "../api/context.tsx";
import { isDesktop } from "./bridge.ts";

const DESKTOP_KEY = ["desktop-shell"] as const;

/**
 * Whether the page runs inside the Amber desktop client: a local-mode backend reached from
 * the Tauri WebView. A local backend opened in a plain browser (development) is not the
 * client, since none of the shell's commands exist there. The one place business
 * components learn this; they never compare the run mode themselves.
 */
export function useDesktop(): boolean {
  const client = useApi();
  const local = client.mode === "local";
  const shell = useQuery({ queryKey: DESKTOP_KEY, queryFn: isDesktop, enabled: local, staleTime: Infinity, gcTime: Infinity });
  return local && shell.data === true;
}
