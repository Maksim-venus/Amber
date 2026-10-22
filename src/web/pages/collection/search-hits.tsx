import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { CollectionItemDto } from "../../../shared/dto/collection.ts";
import { ErrorView } from "../../components/error-view.tsx";
import { actionTarget, type ContentActions } from "../../components/use-content-actions.tsx";
import { HitSnippet } from "../../search/hit-snippet.tsx";
import { hitsByContent, type useSearch } from "../../search/search.ts";
import { useContextMenuTarget } from "../../ui/context-menu.tsx";
import { EmptyState, Loading } from "../../ui/feedback.tsx";
import { appErrorOf } from "../../components/confirm-dialog.tsx";

/**
 * The lectures a collection-scoped search hit, best first, each with one excerpt. Ordering
 * by relevance replaces the course order while a query is in effect, so nothing here can be
 * dragged. A right click on a hit offers the Content's actions, its "open" following the
 * excerpt when the click was on it.
 */
export function SearchHits(props: {
  items: readonly CollectionItemDto[];
  search: ReturnType<typeof useSearch>;
  /** The Content actions of the page, which renders their dialogs. */
  actions: ContentActions;
}) {
  const { t } = useTranslation();
  const { search, actions } = props;
  const menuRef = useContextMenuTarget<HTMLOListElement>((hit) => {
    const itemId = hit.target.closest<HTMLElement>("[data-item-id]")?.dataset["itemId"];
    const item = props.items.find((candidate) => candidate.id === itemId);
    if (item === undefined) return undefined;
    const target = actionTarget({ id: item.contentId, title: item.title, pinnedAt: item.pinnedAt, sourceUrl: item.sourceUrl });
    return actions.menu(target, hit);
  });
  if (search.data === undefined) {
    return search.isError ? <ErrorView error={appErrorOf(search.error)} /> : <Loading />;
  }
  const lectureOf = new Map(props.items.map((item, index) => [item.contentId, { item, index }]));
  const hits = hitsByContent(search.data).flatMap((hit) => {
    const lecture = lectureOf.get(hit.contentId);
    return lecture === undefined ? [] : [{ ...hit, ...lecture }];
  });
  if (hits.length === 0) {
    return <EmptyState title={t("search.empty")} hint={t("search.emptyHint")} />;
  }
  return (
    <ol ref={menuRef} className="divide-y divide-line rounded-lg border border-line">
      {hits.map(({ item, index, first }) => (
        <li key={item.id} className="flex flex-col px-3 py-2" data-testid="collection-hit" data-item-id={item.id}>
          <div className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-xs text-muted">{t("library.collection.lecture", { n: index + 1 })}</span>
            <Link to={`/contents/${item.contentId}`} className="min-w-0 flex-1 truncate text-sm hover:underline">
              {item.title ?? t("library.untitled")}
            </Link>
          </div>
          <div className="pl-[4.25rem]">
            <HitSnippet entry={first} query={search.query} />
          </div>
        </li>
      ))}
    </ol>
  );
}
