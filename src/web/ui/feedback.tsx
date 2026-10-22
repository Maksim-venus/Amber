import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export function Spinner({ size = 16 }: { size?: number }) {
  return <LoaderCircle size={size} className="animate-spin text-muted" aria-hidden="true" />;
}

export function Loading() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-muted" role="status">
      <Spinner />
      {t("common.state.loading")}
    </div>
  );
}

export function EmptyState(props: { title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <p className="text-sm font-medium">{props.title}</p>
      {props.hint === undefined ? null : <p className="max-w-md text-sm text-muted">{props.hint}</p>}
      {props.children}
    </div>
  );
}

export function PageHeader(props: { title: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex min-h-14 items-center justify-between gap-4 border-b border-line px-6">
      <h1 className="truncate text-lg font-semibold">{props.title}</h1>
      <div className="flex items-center gap-2">{props.actions}</div>
    </header>
  );
}
