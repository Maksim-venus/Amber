import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, type ReactNode } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { z } from "zod";
import { ApiError } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { useMe, useSettings } from "../api/queries.ts";
import { ErrorView } from "../components/error-view.tsx";
import { initI18n } from "../i18n.ts";
import { applyTheme } from "../shell/theme.ts";
import { ShortcutProvider } from "../shortcut-registry.tsx";
import { Loading } from "../ui/feedback.tsx";
import { forgetNext, isAuthPage, rememberNext } from "./next-path.ts";

/**
 * The authentication boundary: the routed app, its user preferences and
 * shortcuts mount only once `/api/auth/me` answers for a principal that need not change
 * its password. Without a session the user goes to `/login`, remembering where they were;
 * a forced password change is the login page's second step. It never probes `/setup`.
 */
export function AuthGate() {
  const client = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const me = useMe();
  const here = `${location.pathname}${location.search}${location.hash}`;
  const current = useRef(here);
  current.current = here;

  useEffect(() => {
    client.onUnauthenticated = () => {
      if (isAuthPage(current.current.split(/[?#]/)[0] ?? "")) return;
      rememberNext(current.current);
      queryClient.clear();
      void navigate("/login", { replace: true });
    };
    return () => {
      client.onUnauthenticated = undefined;
    };
  }, [client, queryClient, navigate]);

  if (me.isPending) {
    return <Loading />;
  }
  if (me.error !== null) {
    if (me.error instanceof ApiError && me.error.status === 401) {
      rememberNext(here);
      return <Navigate to="/login" replace />;
    }
    return <div className="p-6">{me.error instanceof ApiError ? <ErrorView error={me.error.error} /> : null}</div>;
  }
  if (me.data.mustChangePassword) {
    rememberNext(here);
    return <Navigate to="/login" replace />;
  }
  return (
    <Preferences>
      <Outlet />
    </Preferences>
  );
}

/** Applies user preferences (theme, language, shortcuts) around the authenticated app. */
function Preferences(props: { children: ReactNode }) {
  const settings = useSettings();
  useEffect(() => {
    applyTheme(settings.data?.theme);
    if (settings.data?.language !== undefined) {
      initI18n(settings.data.language);
    }
  }, [settings.data?.theme, settings.data?.language]);
  return <ShortcutProvider overrides={settings.data?.shortcuts ?? {}}>{props.children}</ShortcutProvider>;
}

/** Logs out (server mode) and returns to `/login` with nothing of the previous session cached. */
export function useLogout(): () => Promise<void> {
  const client = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    try {
      await client.post("/api/auth/logout", z.unknown(), { authRedirect: false });
    } finally {
      forgetNext();
      queryClient.clear();
      void navigate("/login", { replace: true });
    }
  };
}

/** Whether the signed-in principal may open the admin area (server-mode administrators). */
export function useIsServerAdmin(): boolean {
  const me = useMe();
  return me.data?.mode === "server" && me.data.role === "admin";
}
