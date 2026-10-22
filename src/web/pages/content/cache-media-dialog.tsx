import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CACHE_MEDIA_TYPES, fittedCacheStem, sanitizeCacheStem, type CacheMediaType } from "../../../shared/cache-file-name.ts";
import { CACHE_MEDIA_MAX_GB, CACHE_MEDIA_MAX_HEIGHT, DISPLAY_NAME_MAX_CHARS } from "../../../shared/defaults.ts";
import type { CacheMediaRequest } from "../../../shared/dto/media.ts";
import { taskAcceptedDtoSchema } from "../../../shared/dto/task.ts";
import { CACHE_MEDIA_QUALITIES, type CacheMediaQuality } from "../../../shared/enums.ts";
import { ApiError } from "../../api/client.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys } from "../../api/queries.ts";
import { ErrorView } from "../../components/error-view.tsx";
import { useCacheLocation } from "../../desktop/cached-media.ts";
import { Button } from "../../ui/button.tsx";
import { Modal } from "../../ui/modal.tsx";
import { contentKeys } from "./content-data.ts";

const DEFAULT_QUALITY: CacheMediaQuality = CACHE_MEDIA_QUALITIES.find((quality) => quality === CACHE_MEDIA_MAX_HEIGHT) ?? CACHE_MEDIA_QUALITIES[0];

/** The extension the preview shows; a video without an MP4 source becomes `.webm` on the server. */
const PREVIEW_EXTENSION: Record<CacheMediaType, string> = { video: "mp4", audio: "mp3" };

/** The `POST /cache-media` body for a choice; the height tier applies to a video only. */
export function cacheMediaRequest(type: CacheMediaType, quality: CacheMediaQuality, fileName: string): CacheMediaRequest {
  return type === "video" ? { type, quality, fileName } : { type, fileName };
}

/**
 * Where the cached file will land, as far as the client can tell: the server's cleaning of
 * the name with `untitled` for a name that cleans to nothing, shortened to fit
 * the cache directory when it is known. The server stays authoritative and may append a
 * number when the name is taken.
 */
export function cachePreviewPath(fileName: string, type: CacheMediaType, untitled: string, cacheDir: string | undefined): string {
  const stem = sanitizeCacheStem(fileName) ?? sanitizeCacheStem(untitled) ?? untitled;
  const name = (dir: string | undefined): string => `${(dir === undefined ? undefined : fittedCacheStem(stem, 1, dir)) ?? stem}.${PREVIEW_EXTENSION[type]}`;
  if (cacheDir === undefined) return name(undefined);
  // The desktop client reports Windows paths; a POSIX path keeps its own separator.
  const separator = cacheDir.includes("\\") || !cacheDir.includes("/") ? "\\" : "/";
  return `${cacheDir.replace(/[\\/]+$/u, "")}${separator}${name(cacheDir)}`;
}

/**
 * 「缓存本视频」 (desktop client): the user picks a video (height tier) or audio
 * only, and the file name, prefilled with the Content's display title; the dialog previews
 * the path and starts a `cache_media` Task, whose progress the caller follows through
 * `onStarted`.
 */
export function CacheMediaDialog(props: {
  contentId: string;
  /** The display title (`customTitle ?? title`), undefined when the Content has none. */
  title: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal open={props.open} onOpenChange={props.onOpenChange} title={t("contentView.cache.title")} description={t("contentView.cache.hint")}>
      {/* Mounted only while open, so every opening starts from the current title and defaults. */}
      <CacheMediaForm contentId={props.contentId} title={props.title} onClose={() => props.onOpenChange(false)} onStarted={props.onStarted} />
    </Modal>
  );
}

function CacheMediaForm(props: { contentId: string; title: string | undefined; onClose: () => void; onStarted: (taskId: string) => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const location = useCacheLocation(true);
  const [type, setType] = useState<CacheMediaType>("video");
  const [quality, setQuality] = useState<CacheMediaQuality>(DEFAULT_QUALITY);
  const [fileName, setFileName] = useState(props.title ?? "");
  const start = useMutation({
    mutationFn: (body: CacheMediaRequest) =>
      client.post(`/api/contents/${encodeURIComponent(props.contentId)}/cache-media`, taskAcceptedDtoSchema, { body, idempotent: true }),
    onSuccess: (accepted) => {
      void queryClient.invalidateQueries({ queryKey: contentKeys.cacheTask(props.contentId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.unfinishedTasks });
      props.onClose();
      props.onStarted(accepted.taskId);
    },
  });
  const preview = cachePreviewPath(fileName, type, t("cacheFile.untitled"), location.data?.path);
  return (
    <div className="flex flex-col gap-3 text-sm">
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs text-muted">{t("contentView.cache.type")}</legend>
        {CACHE_MEDIA_TYPES.map((value) => (
          <label key={value} className="inline-flex items-center gap-2">
            <input type="radio" name="cache-type" value={value} checked={type === value} onChange={() => setType(value)} data-testid={`cache-type-${value}`} />
            {t(`contentView.cache.typeValue.${value}`)}
          </label>
        ))}
      </fieldset>
      {type === "video" ? (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">{t("contentView.cache.quality")}</span>
          <select
            className="h-8 rounded border border-line bg-surface px-2"
            value={quality}
            onChange={(event) => setQuality(Number(event.target.value) as CacheMediaQuality)}
            data-testid="cache-quality"
          >
            {CACHE_MEDIA_QUALITIES.map((value) => (
              <option key={value} value={value}>
                {t("contentView.cache.qualityValue", { height: value })}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">{t("contentView.cache.fileName")}</span>
        <input
          className="h-8 rounded border border-line bg-surface px-2"
          value={fileName}
          maxLength={DISPLAY_NAME_MAX_CHARS}
          onChange={(event) => setFileName(event.target.value)}
          data-testid="cache-file-name"
        />
      </label>
      <div className="flex flex-col gap-1 text-xs text-muted">
        <p className="break-all" data-testid="cache-preview">
          {t("contentView.cache.preview", { path: preview })}
        </p>
        <p>{t("contentView.cache.numbered")}</p>
        <p>{t("contentView.cache.eviction", { max: CACHE_MEDIA_MAX_GB })}</p>
      </div>
      {start.error instanceof ApiError ? <ErrorView error={start.error.error} /> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={props.onClose}>{t("common.action.cancel")}</Button>
        <Button variant="primary" disabled={start.isPending} onClick={() => start.mutate(cacheMediaRequest(type, quality, fileName))} data-testid="cache-start">
          {t("contentView.cache.start")}
        </Button>
      </div>
    </div>
  );
}
