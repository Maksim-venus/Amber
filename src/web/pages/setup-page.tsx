import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { PASSWORD_MIN_LEN } from "../../shared/defaults.ts";
import { authMeDtoSchema } from "../../shared/dto/system.ts";
import { ApiError } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { queryKeys } from "../api/queries.ts";
import { AUTH_INPUT, AuthCard } from "../auth/auth-card.tsx";
import { takeNext } from "../auth/next-path.ts";
import { ErrorView } from "../components/error-view.tsx";
import { Button } from "../ui/button.tsx";
import { PasswordField } from "../ui/password-input.tsx";

/** The request header that carries the one-time setup token; never the URL. */
const SETUP_TOKEN_HEADER = "x-amber-setup-token";

/**
 * `/setup`: creates the first administrator with the one-time token
 * printed on the server console. Nothing is requested on load — the page only learns
 * whether the token is valid or the instance already initialized when the form is sent.
 */
export function SetupPage() {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const setup = useMutation({
    mutationFn: () =>
      client.post("/api/setup", authMeDtoSchema, {
        body: { username, password, ...(displayName.trim() === "" ? {} : { displayName: displayName.trim() }) },
        headers: { [SETUP_TOKEN_HEADER]: token.trim() },
        authRedirect: false,
      }),
    onSuccess: (me) => {
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== queryKeys.me[0] });
      queryClient.setQueryData(queryKeys.me, me);
      void navigate(me.mustChangePassword ? "/login" : takeNext(), { replace: true });
    },
  });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setProblem(undefined);
    if ([...password].length < PASSWORD_MIN_LEN) return setProblem(t("admin.users.passwordTooShort", { min: PASSWORD_MIN_LEN }));
    if (password !== confirm) return setProblem(t("auth.changePassword.mismatch"));
    setup.mutate();
  };
  const failure = setup.error instanceof ApiError ? setup.error : undefined;
  return (
    <AuthCard
      title={t("auth.setup.title")}
      intro={t("auth.setup.intro")}
      footer={
        <Link to="/login" className="text-accent hover:underline">
          {t("auth.setup.backToLogin")}
        </Link>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-3" data-testid="setup-form">
        <label className="flex flex-col gap-1 text-sm">
          {t("auth.setup.token")}
          <input autoComplete="off" spellCheck={false} required value={token} onChange={(event) => setToken(event.target.value)} className={`${AUTH_INPUT} font-mono`} />
          <span className="text-xs text-muted">{t("auth.setup.tokenHint")}</span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t("auth.setup.username")}
          <input autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} className={AUTH_INPUT} />
          <span className="text-xs text-muted">{t("auth.setup.usernameHint")}</span>
        </label>
        <PasswordField label={t("auth.setup.password")} autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} className={AUTH_INPUT} />
        <PasswordField label={t("auth.setup.confirmPassword")} autoComplete="new-password" required value={confirm} onChange={(event) => setConfirm(event.target.value)} className={AUTH_INPUT} />
        <label className="flex flex-col gap-1 text-sm">
          {t("auth.setup.displayName")}
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} className={AUTH_INPUT} />
        </label>
        {problem === undefined ? null : <p className="text-sm text-danger">{problem}</p>}
        {failure === undefined ? null : failure.status === 401 ? (
          <p role="alert" className="text-sm text-danger">
            {t("auth.setup.badToken")}
          </p>
        ) : failure.status === 409 ? (
          <p role="alert" className="text-sm text-danger">
            {t("auth.setup.alreadyInitialized")}{" "}
            <Link to="/login" className="text-accent underline">
              {t("auth.setup.goLogin")}
            </Link>
          </p>
        ) : (
          <ErrorView error={failure.error} />
        )}
        <Button type="submit" variant="primary" disabled={setup.isPending}>
          {setup.isPending ? t("auth.setup.submitting") : t("auth.setup.submit")}
        </Button>
      </form>
    </AuthCard>
  );
}
