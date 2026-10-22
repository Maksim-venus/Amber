import { useMutation } from "@tanstack/react-query";
import type { CollectionExportRequest, ContentExportRequest } from "../../shared/dto/export.ts";
import type { ExportedFile } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { exportSaver } from "./export-saver.ts";

/** `POST /api/contents/:id/export`: the file itself, every revision named explicitly. */
export function useContentExport(contentId: string) {
  const client = useApi();
  return (body: ContentExportRequest): Promise<ExportedFile> => client.postFile(`/api/contents/${encodeURIComponent(contentId)}/export`, body);
}

/** Exports a Content and saves the file. */
export function useSaveContentExport(contentId: string) {
  const fetchFile = useContentExport(contentId);
  return useMutation({ mutationFn: async (body: ContentExportRequest) => exportSaver().save(await fetchFile(body)) });
}

/** Exports a Collection's Markdown and saves the file. */
export function useSaveCollectionExport(collectionId: string) {
  const client = useApi();
  return useMutation({
    mutationFn: async (body: CollectionExportRequest) =>
      exportSaver().save(await client.postFile(`/api/collections/${encodeURIComponent(collectionId)}/export`, body)),
  });
}
