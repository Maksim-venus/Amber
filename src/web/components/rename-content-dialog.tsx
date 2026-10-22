import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { DISPLAY_NAME_MAX_CHARS } from "../../shared/defaults.ts";
import { contentDetailDtoSchema, type ContentDetailDto } from "../../shared/dto/content.ts";
import { ApiError } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { queryKeys, usePatchContent } from "../api/queries.ts";
import { Button } from "../ui/button.tsx";
import { Loading } from "../ui/feedback.tsx";
import { Modal } from "../ui/modal.tsx";
import { ErrorView } from "./error-view.tsx";

/**
 * The user's own title for one Content. The platform's or file's title is
 * kept, so a renamed Content can go back to it. Shared by the sidebar row menu, the
 * content page title and the library row.
 */
export function RenameContentDialog(props: { contentId: string | undefined; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <Modal open={props.contentId !== undefined} onOpenChange={props.onOpenChange} title={t("library.rename.title")}>
      {props.contentId === undefined ? null : <RenameEditor contentId={props.contentId} onDone={() => props.onOpenChange(false)} />}
    </Modal>
  );
}

function RenameEditor(props: { contentId: string; onDone: () => void }) {
  const client = useApi();
  const { contentId } = props;
  // Same key and schema as the content page, so both read one cached detail.
  const content = useQuery({
    queryKey: queryKeys.content(contentId),
    queryFn: () => client.get(`/api/contents/${encodeURIComponent(contentId)}`, contentDetailDtoSchema),
  });
  if (content.data === undefined) {
    return content.error instanceof ApiError ? <ErrorView error={content.error.error} /> : <Loading />;
  }
  return <RenameForm content={content.data} onDone={props.onDone} />;
}

function RenameForm(props: { content: ContentDetailDto; onDone: () => void }) {
  const { t } = useTranslation();
  const patch = usePatchContent();
  const { content } = props;
  const [title, setTitle] = useState(content.title ?? "");
  const trimmed = title.trim();
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (trimmed === "") return;
    if (trimmed === content.title) return props.onDone();
    patch.mutate({ contentId: content.id, patch: { title: trimmed } }, { onSuccess: props.onDone });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" data-testid="rename-content">
      <label className="flex flex-col gap-1 text-sm">
        {t("library.rename.label")}
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={DISPLAY_NAME_MAX_CHARS}
          autoFocus
          className="h-9 rounded-md border border-line bg-surface px-2"
        />
      </label>
      {patch.error instanceof ApiError ? <ErrorView error={patch.error.error} /> : null}
      <div className="flex items-center justify-end gap-2">
        {content.customTitle === undefined ? null : (
          <Button
            className="mr-auto"
            variant="ghost"
            disabled={patch.isPending}
            onClick={() => patch.mutate({ contentId: content.id, patch: { title: null } }, { onSuccess: props.onDone })}
          >
            {t("library.rename.restore")}
          </Button>
        )}
        <Button onClick={props.onDone}>{t("common.action.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={trimmed === "" || patch.isPending}>
          {t("common.action.save")}
        </Button>
      </div>
    </form>
  );
}
