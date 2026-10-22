import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { CollectionSummaryDto } from "../../../shared/dto/collection.ts";
import { RichText } from "../../components/rich-text.tsx";
import { TaskFlow } from "../../components/task-flow.tsx";
import { Button } from "../../ui/button.tsx";
import { citationHref } from "./citation-target.ts";

/**
 * The collection's rollup summary: generated only on explicit request,
 * partials expandable once the final is published, stale reasons shown on top.
 */
export function SummaryCard(props: { summary: CollectionSummaryDto; onGenerate: () => void; generating?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [showPartials, setShowPartials] = useState(false);
  const { summary } = props;
  const current = summary.current;
  const openCitation = (segmentId: string): void => {
    const href = current === undefined ? undefined : citationHref(segmentId, current);
    if (href !== undefined) {
      void navigate(href);
    }
  };
  return (
    <section className="rounded-lg border border-line p-4" aria-label={t("library.summary.title")} data-testid="collection-summary">
      <h2 className="mb-2 text-sm font-semibold">{t("library.summary.title")}</h2>
      {summary.activeTaskId === undefined ? null : (
        <div className="mb-3">
          <TaskFlow taskId={summary.activeTaskId} />
        </div>
      )}
      {summary.hiddenReason !== undefined ? (
        // The body is withheld while a summarised lecture is in the trash; saying "not
        // generated yet" here would invite summarising again for no reason.
        <p className="rounded bg-sunken px-3 py-2 text-sm text-muted" role="status" data-testid="collection-summary-hidden">
          {t(`library.summary.hidden.${summary.hiddenReason}`)}
        </p>
      ) : summary.stale && summary.staleReason !== undefined ? (
        <p className="mb-3 rounded bg-accent-soft px-3 py-2 text-xs text-accent" role="status">
          {t(`library.summary.stale.${summary.staleReason}`)}
        </p>
      ) : null}
      {summary.hiddenReason !== undefined ? null : current === undefined ? (
        summary.activeTaskId === undefined ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm">{t("library.summary.notGenerated")}</p>
            <p className="text-xs text-muted">{t("library.summary.notGeneratedHint")}</p>
            <Button variant="primary" disabled={props.generating === true} onClick={props.onGenerate}>
              {t("library.summary.generate")}
            </Button>
          </div>
        ) : null
      ) : (
        <>
          {current.quality === "degraded" ? <p className="mb-2 text-xs text-muted">{t("library.summary.degraded")}</p> : null}
          <RichText source={current.body} onCitation={openCitation} />
          {current.partials.length === 0 ? null : (
            <div className="mt-4 border-t border-line pt-3">
              <button type="button" className="flex items-center gap-1 text-xs text-muted hover:underline" aria-expanded={showPartials} onClick={() => setShowPartials(!showPartials)}>
                {showPartials ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {t("library.summary.partials", { count: current.partials.length })}
              </button>
              {showPartials ? (
                <ol className="mt-2 flex flex-col gap-3">
                  {[...current.partials]
                    .sort((a, b) => a.index - b.index)
                    .map((partial) => (
                      <li key={partial.id} className="rounded bg-panel p-3">
                        <p className="mb-1 text-xs font-medium text-muted">{t("library.summary.partial", { n: partial.index + 1 })}</p>
                        <RichText source={partial.body} onCitation={openCitation} />
                      </li>
                    ))}
                </ol>
              ) : null}
            </div>
          )}
        </>
      )}
    </section>
  );
}
