import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ApiClient } from "./client.ts";
import { ContentEventBus } from "./content-events.ts";
import { TaskHub, type TaskView } from "./task-hub.ts";

interface ApiContextValue {
  client: ApiClient;
  hub: TaskHub;
  contentEvents: ContentEventBus;
}

const ApiContext = createContext<ApiContextValue | undefined>(undefined);

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // Explicit refreshes and task events drive updates; focus refetching would hide
      // that nothing is fetched behind the user's back.
      queries: { refetchOnWindowFocus: false, retry: false, staleTime: 5_000 },
      mutations: { retry: false },
    },
  });
}

export function ApiProvider(props: { client: ApiClient; queryClient: QueryClient; children: ReactNode }) {
  const [hub] = useState(() => new TaskHub(props.client));
  const [contentEvents] = useState(() => new ContentEventBus());
  useEffect(() => () => hub.close(), [hub]);
  useEffect(() => () => contentEvents.close(), [contentEvents]);
  return (
    <ApiContext.Provider value={{ client: props.client, hub, contentEvents }}>
      <QueryClientProvider client={props.queryClient}>{props.children}</QueryClientProvider>
    </ApiContext.Provider>
  );
}

function useApiContext(): ApiContextValue {
  const value = useContext(ApiContext);
  if (value === undefined) {
    throw new Error("ApiProvider missing");
  }
  return value;
}

export function useApi(): ApiClient {
  return useApiContext().client;
}

export function useTaskHub(): TaskHub {
  return useApiContext().hub;
}

/** Trash / restore / purge events of this tab and the user's other tabs. */
export function useContentEvents(): ContentEventBus {
  return useApiContext().contentEvents;
}

/** Live snapshot of one task; undefined id means nothing to watch. */
export function useTask(taskId: string | undefined): TaskView {
  const hub = useTaskHub();
  // A stable subscribe function: a new one per render would unwatch and re-watch the task,
  // dropping its snapshot and reloading it on every render.
  const subscribe = useCallback(
    (listener: () => void) => (taskId === undefined ? () => undefined : hub.watch(taskId, listener)),
    [hub, taskId],
  );
  return useSyncExternalStore(subscribe, () => (taskId === undefined ? NO_TASK : hub.view(taskId)));
}

const NO_TASK: TaskView = {};
