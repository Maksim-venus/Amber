import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { saveGrantDtoSchema } from "../../shared/dto/local-media.ts";
import { burnOutputListDtoSchema } from "../../shared/dto/media.ts";
import type { SubtitleVideoContainer } from "../../shared/enums.ts";
import type { ApiClient } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { saveBurnOutput } from "./bridge.ts";

export const burnOutputsKey = ["burn-outputs"] as const;

/** Burn products not yet saved out of the data directory. */
export function fetchBurnOutputs(client: ApiClient) {
  return client.get("/api/media/burn-outputs", burnOutputListDtoSchema);
}

export function useBurnOutputs(enabled: boolean) {
  const client = useApi();
  return useQuery({ queryKey: burnOutputsKey, queryFn: () => fetchBurnOutputs(client), enabled });
}

/**
 * Saves one burn product where the user chooses: the sidecar signs a
 * `burn_output` grant, the shell checks it and copies the file through its save dialog,
 * and only then is the copy in the data directory deleted. `null` when the user cancelled
 * the dialog; the product then stays listed until saved or deleted.
 */
export async function saveBurnProduct(client: ApiClient, assetId: string, suggestedName: string): Promise<{ savedPath: string } | null> {
  const { grant } = await client.post(`/api/media/${encodeURIComponent(assetId)}/save-grant`, saveGrantDtoSchema);
  const saved = await saveBurnOutput(grant, suggestedName);
  if (saved !== null) {
    await deleteBurnProduct(client, assetId);
  }
  return saved;
}

export function deleteBurnProduct(client: ApiClient, assetId: string): Promise<undefined> {
  return client.delete(`/api/media/${encodeURIComponent(assetId)}`, z.undefined());
}

/** Containers a subtitled video export produces, by the MIME type the sidecar records. */
const BURN_OUTPUT_FORMATS: Readonly<Record<string, SubtitleVideoContainer>> = {
  "video/mp4": "mp4",
  "video/x-matroska": "mkv",
};

/** The container of a burn product, when its MIME type is one an export produces. */
export function burnOutputFormat(mimeType: string): SubtitleVideoContainer | undefined {
  return BURN_OUTPUT_FORMATS[mimeType.toLowerCase()];
}

/**
 * The default file name of a burn product: the Content title, never a path, with the
 * extension of its container. The shell recognizes the container from the file itself and
 * corrects the extension if needed, so an unknown type leaves the title bare.
 */
export function burnFileName(title: string, mimeType: string): string {
  const format = burnOutputFormat(mimeType);
  return format === undefined ? title : `${title}.${format}`;
}
