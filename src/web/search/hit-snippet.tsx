import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { formatDuration } from "../format.ts";
import { Highlighted } from "./highlighted.tsx";
import { hitLink, type ContentSideHit } from "./search.ts";

/** One highlighted excerpt under a listed Content; it opens the sentence or summary it came from. */
export function HitSnippet(props: { entry: ContentSideHit; query: string }) {
  const { t } = useTranslation();
  const { entry } = props;
  const label =
    entry.kind === "segment" ? formatDuration(entry.hit.startMs) : entry.kind === "summary" ? t("search.kind.summary") : t(`search.kind.${entry.hit.matchedIn}`);
  return (
    <Link to={hitLink(entry, props.query)} className="mt-1 flex gap-2 text-xs text-muted hover:text-ink" data-testid="search-snippet">
      <span className="shrink-0 font-mono text-accent">{label}</span>
      <Highlighted text={entry.hit.snippet} ranges={entry.hit.ranges} className="line-clamp-2" />
    </Link>
  );
}
