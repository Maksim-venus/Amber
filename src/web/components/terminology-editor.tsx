import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { TERMINOLOGY_MAX_ENTRIES } from "../../shared/defaults.ts";
import { terminologyDtoSchema, type PutTerminologyRequest, type TerminologyDto } from "../../shared/dto/terminology.ts";
import { ApiError } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { queryString } from "../api/queries.ts";
import { Button } from "../ui/button.tsx";
import { Loading } from "../ui/feedback.tsx";
import { ErrorView } from "./error-view.tsx";

type Entry = PutTerminologyRequest["entries"][number];

interface Row {
  term: string;
  translation: string;
  keepOriginal: boolean;
}

function rowsOf(dto: TerminologyDto): Row[] {
  return dto.entries.map((entry) => ({ term: entry.term, translation: entry.translation ?? "", keepOriginal: entry.rule === "keep_original" }));
}

function entriesOf(rows: readonly Row[]): Entry[] {
  return rows
    .filter((row) => row.term.trim() !== "")
    .map((row) => ({
      term: row.term.trim(),
      ...(row.translation.trim() === "" ? {} : { translation: row.translation.trim() }),
      ...(row.keepOriginal ? { rule: "keep_original" as const } : {}),
    }));
}

const INPUT = "h-8 w-full rounded border border-line bg-surface px-2 text-sm outline-none focus:border-accent";

/**
 * Edits one terminology scope (`global`, `collection:<id>`, `content:<id>`) as a whole
 * table: saving replaces every entry, order included. Limits and duplicate
 * keys are the server's to reject; its AppError is shown as is.
 */
export function TerminologyEditor({ scope }: { scope: string }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const key = ["terminology", scope] as const;
  const path = `/api/terminology${queryString({ scope })}`;
  const loaded = useQuery({ queryKey: key, queryFn: () => client.get(path, terminologyDtoSchema) });
  const [rows, setRows] = useState<Row[] | undefined>(undefined);
  const save = useMutation({
    mutationFn: (entries: Entry[]) => client.put(path, terminologyDtoSchema, { body: { entries } }),
    onSuccess: (dto) => {
      queryClient.setQueryData(key, dto);
      setRows(undefined);
    },
  });
  if (loaded.isPending) {
    return <Loading />;
  }
  if (loaded.data === undefined) {
    return loaded.error instanceof ApiError ? <ErrorView error={loaded.error.error} /> : null;
  }
  const shown = rows ?? rowsOf(loaded.data);
  const update = (index: number, change: Partial<Row>): void => setRows(shown.map((row, i) => (i === index ? { ...row, ...change } : row)));
  const tooMany = shown.length > TERMINOLOGY_MAX_ENTRIES;
  return (
    <div data-terminology-scope={scope}>
      {shown.length === 0 ? <p className="mb-2 text-sm text-muted">{t("settings.terminology.empty")}</p> : null}
      {shown.length === 0 ? null : (
        <table className="mb-2 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="pb-1 font-medium">{t("settings.terminology.term")}</th>
              <th className="pb-1 font-medium">{t("settings.terminology.translation")}</th>
              <th className="pb-1 font-medium">{t("settings.terminology.ruleKeepOriginal")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) => (
              <tr key={index}>
                <td className="pr-2 pb-1">
                  <input aria-label={t("settings.terminology.term")} className={INPUT} value={row.term} onChange={(event) => update(index, { term: event.target.value })} />
                </td>
                <td className="pr-2 pb-1">
                  <input
                    aria-label={t("settings.terminology.translation")}
                    className={INPUT}
                    value={row.translation}
                    onChange={(event) => update(index, { translation: event.target.value })}
                  />
                </td>
                <td className="pr-2 pb-1 text-center">
                  <input
                    type="checkbox"
                    aria-label={t("settings.terminology.ruleKeepOriginal")}
                    checked={row.keepOriginal}
                    onChange={(event) => update(index, { keepOriginal: event.target.checked })}
                  />
                </td>
                <td className="pb-1">
                  <Button size="sm" variant="ghost" onClick={() => setRows(shown.filter((_, i) => i !== index))}>
                    {t("settings.terminology.remove")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={shown.length >= TERMINOLOGY_MAX_ENTRIES} onClick={() => setRows([...shown, { term: "", translation: "", keepOriginal: false }])}>
          {t("settings.terminology.add")}
        </Button>
        <Button size="sm" variant="primary" disabled={rows === undefined || tooMany || save.isPending} onClick={() => save.mutate(entriesOf(shown))}>
          {t("common.action.save")}
        </Button>
        <span className={`text-xs ${tooMany ? "text-danger" : "text-muted"}`}>
          {t("settings.terminology.count", { count: shown.length, max: TERMINOLOGY_MAX_ENTRIES })}
        </span>
      </div>
      {save.error instanceof ApiError ? (
        <div className="mt-2">
          <ErrorView error={save.error.error} />
        </div>
      ) : null}
    </div>
  );
}
