import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { PASSWORD_MIN_LEN } from "../../shared/defaults.ts";
import { authMeDtoSchema, type AuthMeDto } from "../../shared/dto/system.ts";
import { ApiError } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { queryKeys } from "../api/queries.ts";
import { ErrorView } from "../components/error-view.tsx";
import { Button } from "../ui/button.tsx";
import { PasswordField } from "../ui/password-input.tsx";

const INPUT = "h-9 w-full rounded-md border border-line bg-surface px-2 text-sm outline-none focus:border-accent";

/**
 * `POST /api/auth/change-password`. The server revokes the user's other
 * sessions on success. When the caller already holds the current password (the login step
 * just verified it) the field is not asked again.
 */
export function ChangePasswordForm(props: { currentPassword?: string; submitLabel: string; onDone: (me: AuthMeDto) => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const change = useMutation({
    mutationFn: () =>
      client.post("/api/auth/change-password", authMeDtoSchema, {
        body: { currentPassword: props.currentPassword ?? current, newPassword: next },
        authRedirect: false,
      }),
    onSuccess: (me) => {
      queryClient.setQueryData(queryKeys.me, me);
      setCurrent("");
      setNext("");
      setConfirm("");
      props.onDone(me);
    },
  });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setProblem(undefined);
    if ([...next].length < PASSWORD_MIN_LEN) return setProblem(t("auth.changePassword.tooShort", { min: PASSWORD_MIN_LEN }));
    if (next !== confirm) return setProblem(t("auth.changePassword.mismatch"));
    change.mutate();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" data-testid="change-password-form">
      {props.currentPassword === undefined ? (
        <PasswordField label={t("auth.changePassword.currentPassword")} autoComplete="current-password" required value={current} onChange={(event) => setCurrent(event.target.value)} className={INPUT} />
      ) : null}
      <PasswordField label={t("auth.changePassword.newPassword")} autoComplete="new-password" required value={next} onChange={(event) => setNext(event.target.value)} className={INPUT} />
      <PasswordField label={t("auth.changePassword.confirmPassword")} autoComplete="new-password" required value={confirm} onChange={(event) => setConfirm(event.target.value)} className={INPUT} />
      {problem === undefined ? null : <p className="text-sm text-danger">{problem}</p>}
      {change.error instanceof ApiError ? (
        // The new password is checked above against the same rules the server applies, so an
        // `invalid_request` here means the current password did not match.
        change.error.error.class === "invalid_request" ? (
          <p role="alert" className="text-sm text-danger">
            {t("auth.changePassword.wrongCurrent")}
          </p>
        ) : (
          <ErrorView error={change.error.error} />
        )
      ) : null}
      <Button type="submit" variant="primary" disabled={change.isPending}>
        {props.submitLabel}
      </Button>
    </form>
  );
}
