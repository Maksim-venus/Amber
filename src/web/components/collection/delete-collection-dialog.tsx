import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { useApi } from "../../api/context.tsx";
import { queryKeys } from "../../api/queries.ts";
import { ConfirmDialog } from "../confirm-dialog.tsx";

/**
 * Asks before deleting a Collection; its Contents stay in the library. `onDeleted` runs
 * once the collection is gone and the lists are refreshed (e.g. leave its page).
 */
export function DeleteCollectionDialog(props: {
  collection: { id: string; name: string } | undefined;
  onOpenChange: (open: boolean) => void;
  onDeleted?: (collectionId: string) => void;
}) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const { collection } = props;
  return (
    <ConfirmDialog
      open={collection !== undefined}
      onOpenChange={props.onOpenChange}
      title={t("library.collection.deleteTitle", { name: collection?.name ?? "" })}
      description={t("library.collection.deleteDescription")}
      confirmLabel={t("common.action.delete")}
      danger
      onConfirm={async () => {
        if (collection === undefined) return;
        await client.delete(`/api/collections/${encodeURIComponent(collection.id)}`, z.undefined());
        await queryClient.invalidateQueries({ queryKey: queryKeys.collections });
        await queryClient.invalidateQueries({ queryKey: queryKeys.contentsAll });
        props.onDeleted?.(collection.id);
      }}
    />
  );
}
