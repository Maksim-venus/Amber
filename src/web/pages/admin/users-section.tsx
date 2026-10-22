import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { PASSWORD_MIN_LEN } from "../../../shared/defaults.ts";
import type { AdminUserDto } from "../../../shared/dto/admin.ts";
import { USER_ROLES, type UserRole } from "../../../shared/enums.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys, useMe } from "../../api/queries.ts";
import { formatDateTime } from "../../format.ts";
import { Button } from "../../ui/button.tsx";
import { Loading } from "../../ui/feedback.tsx";
import { Modal } from "../../ui/modal.tsx";
import { ConfirmDialog } from "../../components/confirm-dialog.tsx";
import { Field, INPUT_CLASS, RequestError, SettingsBlock } from "../settings/settings-ui.tsx";
import { adminKeys, useAdminUsers } from "./admin-data.ts";
import { PasswordInput } from "../../ui/password-input.tsx";

type Dialog =
  | { kind: "create" }
  | { kind: "edit"; user: AdminUserDto }
  | { kind: "reset"; user: AdminUserDto }
  | { kind: "suspend"; user: AdminUserDto }
  | { kind: "delete"; user: AdminUserDto };

const userPath = (id: string): string => `/api/admin/users/${encodeURIComponent(id)}`;
const WIDE_ONLY = "hidden @2xl:table-cell";

/**
 * `/admin/users`: create accounts, suspend / resume, change role,
 * display name and quota, reset passwords and delete. Suspension, reset and deletion end
 * every session of the user on the server.
 */
export function UsersSection() {
  const { t, i18n } = useTranslation();
  const limitOf = (user: AdminUserDto): string => (user.storageLimitGB === undefined ? t("admin.users.noLimit") : `${user.storageLimitGB} GB`);
  const client = useApi();
  const queryClient = useQueryClient();
  const me = useMe();
  const users = useAdminUsers();
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: adminKeys.users });
    void queryClient.invalidateQueries({ queryKey: adminKeys.storage });
    // An administrator may have renamed themselves; the account card shows that name.
    void queryClient.invalidateQueries({ queryKey: queryKeys.me });
  };
  const patch = useMutation({
    mutationFn: (input: { id: string; body: Record<string, unknown> }) => client.patch(userPath(input.id), z.unknown(), { body: input.body }),
    onSuccess: refresh,
  });
  const close = (): void => setDialog(undefined);

  return (
    <div>
      <SettingsBlock
        intro={t("admin.users.intro")}
        actions={
          <Button variant="primary" size="sm" onClick={() => setDialog({ kind: "create" })}>
            {t("admin.users.create")}
          </Button>
        }
      >
        {users.isPending ? <Loading /> : null}
        <RequestError error={users.error} />
        <RequestError error={patch.error} />
        {users.data?.users.length === 0 ? <p className="text-sm text-muted">{t("admin.users.empty")}</p> : null}
        {users.data === undefined || users.data.users.length === 0 ? null : (
          // Below 42rem of list width status, quota and creation time fold under the username.
          <div className="@container">
            <table className="w-full text-sm" data-testid="admin-users">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="pr-3 pb-1 font-medium">{t("admin.users.username")}</th>
                  <th className="pr-3 pb-1 font-medium">{t("admin.users.role")}</th>
                  <th className={`${WIDE_ONLY} pr-3 pb-1 font-medium whitespace-nowrap`}>{t("admin.users.status")}</th>
                  <th className={`${WIDE_ONLY} pr-3 pb-1 font-medium whitespace-nowrap`}>{t("admin.users.storageLimit")}</th>
                  <th className={`${WIDE_ONLY} pr-3 pb-1 font-medium whitespace-nowrap`}>{t("admin.users.createdAt")}</th>
                  <th className="pb-1 font-medium">{t("admin.users.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {users.data.users.map((user) => (
                  <tr key={user.id} className="border-t border-line align-top" data-user-id={user.id}>
                    <td className="py-1.5 pr-3">
                      <span className="font-medium">{user.username}</span>
                      {user.id === me.data?.userId ? <span className="text-xs text-muted">{t("admin.users.you")}</span> : null}
                      {user.displayName === undefined ? null : <span className="block text-xs text-muted">{user.displayName}</span>}
                      {user.mustChangePassword ? <span className="block text-xs text-muted">{t("admin.users.mustChangePassword")}</span> : null}
                      <span className="block text-xs text-muted @2xl:hidden" data-testid="admin-user-meta">
                        {[t(`admin.users.statusValue.${user.status}`), limitOf(user), formatDateTime(user.createdAt, i18n.language)].join(" · ")}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3">
                      <select
                        aria-label={t("admin.users.role")}
                        className="h-7 rounded border border-line bg-surface px-1 text-xs"
                        value={user.role}
                        disabled={patch.isPending}
                        onChange={(event) => patch.mutate({ id: user.id, body: { role: event.target.value as UserRole } })}
                      >
                        {USER_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {t(`admin.users.roleValue.${role}`)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className={`${WIDE_ONLY} py-1.5 pr-3 whitespace-nowrap`}>{t(`admin.users.statusValue.${user.status}`)}</td>
                    <td className={`${WIDE_ONLY} py-1.5 pr-3 whitespace-nowrap`}>{limitOf(user)}</td>
                    <td className={`${WIDE_ONLY} py-1.5 pr-3 text-xs whitespace-nowrap text-muted`}>{formatDateTime(user.createdAt, i18n.language)}</td>
                    <td className="py-1.5">
                      <div className="flex flex-wrap gap-1">
                        {user.status === "active" ? (
                          <Button size="sm" onClick={() => setDialog({ kind: "suspend", user })}>
                            {t("admin.users.suspend")}
                          </Button>
                        ) : (
                          <Button size="sm" disabled={patch.isPending} onClick={() => patch.mutate({ id: user.id, body: { status: "active" } })}>
                            {t("admin.users.resume")}
                          </Button>
                        )}
                        <Button size="sm" onClick={() => setDialog({ kind: "edit", user })}>
                          {t("admin.users.edit")}
                        </Button>
                        <Button size="sm" onClick={() => setDialog({ kind: "reset", user })}>
                          {t("admin.users.resetPassword")}
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => setDialog({ kind: "delete", user })}>
                          {t("admin.users.delete")}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SettingsBlock>

      {dialog?.kind === "create" ? <CreateUserDialog onClose={close} onDone={refresh} /> : null}
      {dialog?.kind === "edit" ? <EditUserDialog user={dialog.user} onClose={close} onDone={refresh} /> : null}
      {dialog?.kind === "reset" ? <ResetPasswordDialog user={dialog.user} onClose={close} onDone={refresh} /> : null}
      <ConfirmDialog
        open={dialog?.kind === "suspend"}
        onOpenChange={(open) => (open ? undefined : close())}
        title={t("settings.common.confirmTitle")}
        description={dialog?.kind === "suspend" ? t("admin.users.suspendConfirm", { username: dialog.user.username }) : ""}
        confirmLabel={t("admin.users.suspend")}
        danger
        onConfirm={async () => {
          if (dialog?.kind !== "suspend") return;
          await client.patch(userPath(dialog.user.id), z.unknown(), { body: { status: "suspended" } });
          refresh();
        }}
      />
      <ConfirmDialog
        open={dialog?.kind === "delete"}
        onOpenChange={(open) => (open ? undefined : close())}
        title={dialog?.kind === "delete" ? t("admin.users.deleteTitle", { username: dialog.user.username }) : ""}
        description={t("admin.users.deleteConfirm")}
        confirmLabel={t("admin.users.delete")}
        danger
        onConfirm={async () => {
          if (dialog?.kind !== "delete") return;
          await client.delete(userPath(dialog.user.id), z.unknown());
          refresh();
        }}
      />
    </div>
  );
}

function CreateUserDialog(props: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<UserRole>("user");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const create = useMutation({
    mutationFn: () =>
      client.post("/api/admin/users", z.unknown(), {
        body: { username, password, role, ...(displayName.trim() === "" ? {} : { displayName: displayName.trim() }) },
      }),
    onSuccess: () => {
      props.onDone();
      props.onClose();
    },
  });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setProblem(undefined);
    if ([...password].length < PASSWORD_MIN_LEN) return setProblem(t("admin.users.passwordTooShort", { min: PASSWORD_MIN_LEN }));
    create.mutate();
  };
  return (
    <Modal open onOpenChange={(open) => (open ? undefined : props.onClose())} title={t("admin.users.createTitle")}>
      <form onSubmit={submit} data-testid="create-user-form">
        <Field label={t("admin.users.username")} hint={t("admin.users.usernameHint")} htmlFor="new-user-name">
          <input id="new-user-name" required autoComplete="off" className={INPUT_CLASS} value={username} onChange={(event) => setUsername(event.target.value)} />
        </Field>
        <Field label={t("admin.users.password")} hint={t("admin.users.passwordHint", { min: PASSWORD_MIN_LEN })} htmlFor="new-user-password">
          <PasswordInput id="new-user-password" required autoComplete="new-password" className={INPUT_CLASS} value={password} onChange={(event) => setPassword(event.target.value)} />
        </Field>
        <Field label={t("admin.users.displayName")} htmlFor="new-user-display">
          <input id="new-user-display" className={INPUT_CLASS} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </Field>
        <Field label={t("admin.users.role")} htmlFor="new-user-role">
          <select id="new-user-role" className={INPUT_CLASS} value={role} onChange={(event) => setRole(event.target.value as UserRole)}>
            {USER_ROLES.map((item) => (
              <option key={item} value={item}>
                {t(`admin.users.roleValue.${item}`)}
              </option>
            ))}
          </select>
        </Field>
        {problem === undefined ? null : <p className="mb-2 text-sm text-danger">{problem}</p>}
        <RequestError error={create.error} />
        <div className="mt-3 flex justify-end gap-2">
          <Button onClick={props.onClose}>{t("common.action.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {t("common.action.create")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function EditUserDialog(props: { user: AdminUserDto; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const [displayName, setDisplayName] = useState(props.user.displayName ?? "");
  const [limit, setLimit] = useState(props.user.storageLimitGB === undefined ? "" : String(props.user.storageLimitGB));
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => client.patch(userPath(props.user.id), z.unknown(), { body }),
    onSuccess: () => {
      props.onDone();
      props.onClose();
    },
  });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setProblem(undefined);
    const body: Record<string, unknown> = {};
    const name = displayName.trim();
    if (name !== (props.user.displayName ?? "")) body["displayName"] = name === "" ? null : name;
    const text = limit.trim();
    if (text === "") {
      if (props.user.storageLimitGB !== undefined) body["storageLimitGB"] = null;
    } else {
      const value = Number(text);
      if (!Number.isFinite(value) || value <= 0) return setProblem(t("admin.users.badLimit"));
      if (value !== props.user.storageLimitGB) body["storageLimitGB"] = value;
    }
    if (Object.keys(body).length === 0) return props.onClose();
    save.mutate(body);
  };
  return (
    <Modal open onOpenChange={(open) => (open ? undefined : props.onClose())} title={t("admin.users.editTitle", { username: props.user.username })}>
      <form onSubmit={submit}>
        <Field label={t("admin.users.displayName")} htmlFor="edit-user-display">
          <input id="edit-user-display" className={INPUT_CLASS} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </Field>
        <Field label={t("admin.users.storageLimitGB")} htmlFor="edit-user-limit">
          <input id="edit-user-limit" inputMode="decimal" className={INPUT_CLASS} value={limit} onChange={(event) => setLimit(event.target.value)} />
        </Field>
        {problem === undefined ? null : <p className="mb-2 text-sm text-danger">{problem}</p>}
        <RequestError error={save.error} />
        <div className="mt-3 flex justify-end gap-2">
          <Button onClick={props.onClose}>{t("common.action.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {t("common.action.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPasswordDialog(props: { user: AdminUserDto; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const reset = useMutation({
    mutationFn: () => client.post(`${userPath(props.user.id)}/reset-password`, z.unknown(), { body: { newPassword: password } }),
    onSuccess: () => {
      props.onDone();
      props.onClose();
    },
  });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setProblem(undefined);
    if ([...password].length < PASSWORD_MIN_LEN) return setProblem(t("admin.users.passwordTooShort", { min: PASSWORD_MIN_LEN }));
    reset.mutate();
  };
  return (
    <Modal open onOpenChange={(open) => (open ? undefined : props.onClose())} title={t("admin.users.resetTitle", { username: props.user.username })} description={t("admin.users.resetHint")}>
      <form onSubmit={submit}>
        <Field label={t("admin.users.newPassword")} hint={t("admin.users.passwordHint", { min: PASSWORD_MIN_LEN })} htmlFor="reset-password">
          <PasswordInput id="reset-password" required autoComplete="new-password" className={INPUT_CLASS} value={password} onChange={(event) => setPassword(event.target.value)} />
        </Field>
        {problem === undefined ? null : <p className="mb-2 text-sm text-danger">{problem}</p>}
        <RequestError error={reset.error} />
        <div className="mt-3 flex justify-end gap-2">
          <Button onClick={props.onClose}>{t("common.action.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={reset.isPending}>
            {t("admin.users.resetPassword")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
