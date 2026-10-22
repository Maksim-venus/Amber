import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { collectionDtoSchema, collectionItemDtoSchema } from "../../shared/dto/collection.ts";
import { contentDetailDtoSchema } from "../../shared/dto/content.ts";
import { ApiError } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { queryKeys, useCollections } from "../api/queries.ts";
import { Button } from "../ui/button.tsx";
import { Loading } from "../ui/feedback.tsx";
import { Modal } from "../ui/modal.tsx";
import { ErrorView } from "./error-view.tsx";

const INPUT = "h-9 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-sm outline-none focus:border-accent";

/**
 * Which collections one Content belongs to: ticking adds it, unticking
 * removes the membership only, and a new collection can be created and joined at once.
 * Shared by the library row, the content page toolbar and the sidebar row menu.
 */
export function CollectionMembershipDialog(props: { contentId: string | undefined; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <Modal open={props.contentId !== undefined} onOpenChange={props.onOpenChange} title={t("library.membership.title")} description={t("library.membership.intro")}>
      {props.contentId === undefined ? null : <MembershipEditor contentId={props.contentId} />}
    </Modal>
  );
}

function MembershipEditor(props: { contentId: string }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const { contentId } = props;
  // Same key and schema as the content page, so both read one cached detail.
  const content = useQuery({
    queryKey: queryKeys.content(contentId),
    queryFn: () => client.get(`/api/contents/${encodeURIComponent(contentId)}`, contentDetailDtoSchema),
  });
  const collections = useCollections();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<unknown>(undefined);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const refresh = async (collectionId: string): Promise<void> => {
    await Promise.all([
      // Exact: the chapters, summaries and tasks keyed under the content do not show membership.
      queryClient.invalidateQueries({ queryKey: queryKeys.content(contentId), exact: true }),
      queryClient.invalidateQueries({ queryKey: queryKeys.contentsAll }),
      queryClient.invalidateQueries({ queryKey: queryKeys.collections }),
      queryClient.invalidateQueries({ queryKey: queryKeys.collection(collectionId) }),
    ]);
  };
  const join = (collectionId: string): Promise<unknown> =>
    client.post(`/api/collections/${encodeURIComponent(collectionId)}/items`, collectionItemDtoSchema, { body: { contentId } });

  // A row stays locked until the refreshed detail shows the new state: a second click on a
  // membership already removed would only answer 404.
  const toggle = async (collectionId: string, itemId: string | undefined): Promise<void> => {
    setPending((current) => new Set(current).add(collectionId));
    setError(undefined);
    try {
      if (itemId === undefined) {
        await join(collectionId);
      } else {
        await client.delete(`/api/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(itemId)}`, z.undefined());
      }
      await refresh(collectionId);
    } catch (caught) {
      setError(caught);
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(collectionId);
        return next;
      });
    }
  };

  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (name.trim() === "") return;
    setCreating(true);
    setError(undefined);
    try {
      const collection = await client.post("/api/collections", collectionDtoSchema, { body: { name: name.trim() } });
      await join(collection.id);
      await refresh(collection.id);
      setName("");
    } catch (caught) {
      setError(caught);
    } finally {
      setCreating(false);
    }
  };

  if (content.data === undefined || collections.data === undefined) {
    const failed = content.error ?? collections.error;
    return failed instanceof ApiError ? <ErrorView error={failed.error} /> : <Loading />;
  }
  const memberships = new Map(content.data.collections.map((membership) => [membership.id, membership.itemId]));
  const items = collections.data.items;
  return (
    <div className="flex flex-col gap-3">
      {items.length === 0 ? (
        <p className="text-sm text-muted">{t("library.membership.empty")}</p>
      ) : (
        <ul className="flex max-h-72 flex-col gap-1 overflow-auto" data-testid="membership-list">
          {items.map((collection) => {
            const itemId = memberships.get(collection.id);
            return (
              <li key={collection.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-sunken">
                  <input
                    type="checkbox"
                    checked={itemId !== undefined}
                    disabled={pending.has(collection.id)}
                    onChange={() => void toggle(collection.id, itemId)}
                  />
                  <span className="truncate">{collection.name}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <form onSubmit={(event) => void create(event)} className="flex gap-2 border-t border-line pt-3">
        <input
          aria-label={t("library.membership.newName")}
          placeholder={t("library.membership.newName")}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={INPUT}
        />
        <Button type="submit" variant="primary" disabled={name.trim() === "" || creating}>
          {t("library.membership.create")}
        </Button>
      </form>
      {error instanceof ApiError ? <ErrorView error={error.error} /> : null}
    </div>
  );
}
