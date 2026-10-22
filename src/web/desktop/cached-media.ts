import { useQuery } from "@tanstack/react-query";
import { cacheLocationDtoSchema, saveGrantDtoSchema } from "../../shared/dto/local-media.ts";
import type { ApiClient } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { saveCachedMedia } from "./bridge.ts";

/** Query key of `GET /api/media/cache-location`, shared by the storage page and the cache dialog. */
export const cacheLocationKey = ["cache-location"] as const;

/** The cache directory (desktop client only; the endpoint is not registered in server mode). */
export function useCacheLocation(enabled: boolean) {
  const client = useApi();
  return useQuery({
    queryKey: cacheLocationKey,
    queryFn: () => client.get("/api/media/cache-location", cacheLocationDtoSchema),
    enabled,
  });
}

/**
 * Copies a platform cache to where the user chooses: the sidecar signs a
 * `cache_save` grant for the cached file and the shell checks it before its save dialog
 * copies the file. The cache itself is kept. `null` when the user cancelled the dialog.
 */
export async function saveCachedCopy(client: ApiClient, assetId: string, suggestedName: string): Promise<{ savedPath: string } | null> {
  const { grant } = await client.post(`/api/media/${encodeURIComponent(assetId)}/save-grant`, saveGrantDtoSchema);
  return saveCachedMedia(grant, suggestedName);
}
