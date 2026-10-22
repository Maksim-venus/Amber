import { monotonicFactory } from "ulid";
import { CACHE_EXTENSIONS, cacheFileNameOf, cacheRef, cacheStemOf, fittedCacheStem, isCacheRef, sanitizeCacheStem } from "../../shared/cache-file-name.ts";
import { CACHE_MEDIA_MAX_HEIGHT } from "../../shared/defaults.ts";
import type { BurnRequest, CacheMediaRequest } from "../../shared/dto/media.ts";
import type { TaskAcceptedDto } from "../../shared/dto/task.ts";
import type { TaskKind } from "../../shared/enums.ts";
import { cacheFile } from "../../shared/i18n/zh-CN/cache-file.ts";
import { canonicalJson } from "../domain/canonical-json.ts";
import { displayTitle, type Content } from "../domain/content.ts";
import { AmberError, amberError } from "../domain/errors.ts";
import { isAudioCache, isVideoCache, type MediaAsset } from "../domain/media-asset.ts";
import { incompatibleStreamDetail, mp4IncompatibleStreams } from "../domain/export/container-policy.ts";
import { burnTaskRequestSchema, cacheMediaTaskRequestSchema, cacheMediaTaskRequestV2Schema } from "../domain/task-request.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import type { SubtitleMuxer } from "../ports/subtitle-muxer.ts";
import { diskLowAfterWriting, diskLowError, type DiskUsageProbe } from "../pipeline/disk-watermark.ts";
import type { TaskEventBus } from "../pipeline/events.ts";
import type { CacheFileStore } from "../pipeline/media-files.ts";
import { laneConflict, laneKeys } from "../pipeline/lane.ts";
import { isTerminalProjection } from "../pipeline/projection.ts";
import { transact } from "../pipeline/publish.ts";
import type { InstanceSettingsSource } from "../pipeline/scheduler.ts";
import { assetPath, availableVideoSource, type AssetPathResolver } from "../pipeline/stages/source-media.ts";
import { createTask } from "../pipeline/task-state.ts";
import { jsonRequestDigest, runIdempotent, type IdempotentResult } from "./idempotency.ts";
import type { TaskControl } from "./tasks.ts";

export const CACHE_MEDIA_ROUTE = "POST /api/contents/:id/cache-media";
export const BURN_ROUTE = "POST /api/contents/:id/burn";

export interface ClientMediaTaskServiceOptions {
  repository: Repository;
  bus: TaskEventBus;
  control: Pick<TaskControl, "kick">;
  /** The data directory's volume, where a burn product lands. */
  disk: DiskUsageProbe;
  /** The cache store: a download lands on its volume, which may not be the data directory's. */
  cache: Pick<CacheFileStore, "diskUsage" | "isAvailable" | "directory">;
  /**
   * Whether a file exists at a cache ref right now. Synchronous because names are
   * allocated inside the submitting transaction, which cannot await.
   */
  cacheFileExists: (ref: string) => boolean;
  /** Refs of purged caches still waiting to be removed from the current cache directory; their names stay taken. */
  pendingCacheRefs?: () => ReadonlySet<string>;
  settings: InstanceSettingsSource;
  /** Where a source video is read from by its kind, for inspecting it before a styled export. */
  media: AssetPathResolver;
  /** Reads the streams of the source video of a styled export. */
  muxer: Pick<SubtitleMuxer, "inspect">;
  now?: () => number;
  newId?: () => string;
}

/** Windows compares file names case-insensitively; so does the cache name allocation. */
function foldCase(name: string): string {
  return name.toLowerCase();
}

/**
 * The client-only Tasks: caching a platform video or its audio as a `platform_cache` asset
 * and burning subtitles into a video. Both are 202 + Task, carry an Idempotency-Key and
 * freeze their request at submission.
 */
export class ClientMediaTaskService {
  private readonly options: ClientMediaTaskServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: ClientMediaTaskServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
  }

  /**
   * Only a platform Content has media to download. `type` defaults to
   * `video`, whose height tier defaults to `CACHE_MEDIA_MAX_HEIGHT`. The low-water probe
   * is the cache volume's for a video, and also the data volume's for audio, which is
   * downloaded into the data directory before it is transcoded into the cache; the stage
   * checks the full budget once the sizes are known. An unmounted custom cache root
   * refuses the Task up front (`conflict.cache_unavailable`). The file name and the id of
   * the asset to register are frozen with the request (`allocateCacheStem`).
   */
  async cacheMedia(principal: RequestPrincipal, contentId: string, body: CacheMediaRequest, idempotencyKey?: string): Promise<IdempotentResult<TaskAcceptedDto>> {
    const cache = this.options.cache;
    if (!(await cache.isAvailable())) {
      throw amberError("conflict", "the video cache root is not available", { code: "conflict.cache_unavailable" });
    }
    const type = body.type ?? "video";
    const probes = type === "audio" ? [this.options.disk, cache] : [cache];
    return this.create(principal, contentId, body, idempotencyKey, CACHE_MEDIA_ROUTE, "cache_media", () => this.checkDisks(probes), (content, scope) => {
      if (content.source.kind === "local") {
        throw amberError("invalid_request", "only platform contents have media to cache", { params: { detail: "contentId" } });
      }
      const fileName = this.allocateCacheStem(scope, content, type, body.fileName);
      return canonicalJson(
        cacheMediaTaskRequestV2Schema.parse({
          requestSchemaVersion: 2,
          kind: "cache_media",
          type,
          ...(type === "video" ? { quality: body.quality ?? CACHE_MEDIA_MAX_HEIGHT } : {}),
          fileName,
          assetId: this.newId(),
        }),
      );
    });
  }

  /**
   * The stem of the new cache file: the cleaned request name when the request has one, else
   * the cleaned display title; whichever cleans to nothing becomes the i18n untitled name.
   * The stem is shortened to fit the Windows path limit under the current cache directory,
   * then numbered ` (2)`, ` (3)`… until it is free. A stem is taken, case-insensitively, by
   * any user's available cache, by a file name frozen in any user's unfinished cache Task, by
   * a purged cache still waiting to be removed from the current cache directory, and by a
   * `<stem>.{mp4,webm,mp3}` file in the cache directory. The one exception is this Content's
   * own cache of the other type, which shares the stem (`title.mp4` next to `title.mp3`); its
   * own cache of the same type does take it, so a new file never lands on the path of the
   * one it replaces.
   */
  private allocateCacheStem(scope: RepositoryScope, content: Content, type: "video" | "audio", requested: string | undefined): string {
    // A name the user typed but that cleans to nothing falls back to the untitled name, not
    // to the title: the user cleared the prefilled title on purpose.
    const base = sanitizeCacheStem(requested ?? displayTitle(content) ?? "") ?? (sanitizeCacheStem(cacheFile.untitled) as string);
    const sibling = (asset: MediaAsset) =>
      asset.userId === content.userId && asset.contentId === content.id && (type === "video" ? isAudioCache(asset) : isVideoCache(asset));
    const caches = scope.mediaAssets.listAvailableCachesUnscoped().filter((asset) => isCacheRef(asset.storageRef));
    const siblingNames = new Set(caches.filter(sibling).map((asset) => foldCase(cacheFileNameOf(asset.storageRef))));
    const taken = new Set(caches.filter((asset) => !sibling(asset)).map((asset) => foldCase(cacheStemOf(asset.storageRef))));
    // Even this Content's own: the file removed later must not be the one cached now.
    for (const ref of this.options.pendingCacheRefs?.() ?? []) {
      taken.add(foldCase(cacheStemOf(ref)));
    }
    for (const task of scope.tasks.listUnfinished()) {
      if (task.kind !== "cache_media") {
        continue;
      }
      const request = cacheMediaTaskRequestSchema.safeParse(JSON.parse(task.requestJson));
      if (request.success && request.data.requestSchemaVersion === 2) {
        taken.add(foldCase(request.data.fileName));
      }
    }
    const onDisk = (stem: string) =>
      CACHE_EXTENSIONS.some((ext) => {
        const ref = cacheRef(stem, ext);
        return !siblingNames.has(foldCase(cacheFileNameOf(ref))) && this.options.cacheFileExists(ref);
      });
    const directory = this.options.cache.directory();
    for (let n = 1; ; n += 1) {
      const candidate = fittedCacheStem(base, n, directory);
      if (candidate === undefined) {
        throw amberError("invalid_request", "the cache directory path leaves no room for a file name", { params: { detail: "fileName" } });
      }
      if (!taken.has(foldCase(candidate)) && !onDisk(candidate)) {
        return candidate;
      }
    }
  }

  /**
   * The revisions are checked the way subtitle export checks them: both belong to the
   * Content, the exported original is not itself a translation, and a translation is one of
   * that original. A video must be available now (the original or a video cache; an audio
   * cache has no picture).
   *
   * Without `delivery` / `container` / `style` this is the legacy burn-in, frozen as schema
   * version 1, whose stage picks the source when it runs. With them (schema version 2) the
   * source is picked and inspected now and frozen with its fingerprint; a soft-subtitle MP4
   * is refused when the source has streams outside the MP4 rule, and the data volume must
   * stay above the low-water mark after an output the size of the source.
   */
  async burn(principal: RequestPrincipal, contentId: string, body: BurnRequest, idempotencyKey?: string): Promise<IdempotentResult<TaskAcceptedDto>> {
    const owner = principal.userId;
    const { delivery, container, style } = body;
    if (delivery === undefined || container === undefined || style === undefined) {
      return this.create(principal, contentId, body, idempotencyKey, BURN_ROUTE, "burn", () => this.checkDisks([this.options.disk]), (content, scope) => {
        checkBurnRevisions(scope, owner, content, body);
        if (availableVideoSource(scope, owner, content.id) === undefined) {
          throw amberError("media_missing", "no available video to burn subtitles into");
        }
        return canonicalJson(
          burnTaskRequestSchema.parse({
            requestSchemaVersion: 1,
            kind: "burn",
            mode: body.mode,
            revisionId: body.revisionId,
            ...(body.translationRevisionId === undefined ? {} : { translationRevisionId: body.translationRevisionId }),
          }),
        );
      });
    }
    let source: MediaAsset | undefined;
    const prepare = async (): Promise<void> => {
      const picked = this.options.repository.withTransaction((scope) => {
        const content = scope.contents.get(owner, contentId);
        if (content === undefined) {
          throw amberError("not_found", `content ${contentId}`);
        }
        checkBurnRevisions(scope, owner, content, body);
        return availableVideoSource(scope, owner, content.id);
      });
      if (picked === undefined) {
        throw amberError("media_missing", "no available video to export subtitles with");
      }
      const inspection = await this.options.muxer.inspect(assetPath(picked, this.options.media), new AbortController().signal);
      if (delivery === "soft" && container === "mp4") {
        const incompatible = mp4IncompatibleStreams(inspection.streams);
        if (incompatible.length > 0) {
          throw amberError("invalid_request", "the video has streams an MP4 cannot carry", {
            code: "invalid_request.container_unsupported",
            details: { streams: incompatible.map(incompatibleStreamDetail) },
          });
        }
      }
      // The output is about the size of the source: re-encoding at a comparable quality or copying it.
      const low = await diskLowAfterWriting(this.options.disk, this.options.settings.effective(), picked.sizeBytes);
      if (low !== undefined) {
        throw new AmberError(low, "disk below the low-water mark after the export");
      }
      source = picked;
    };
    return this.create(principal, contentId, body, idempotencyKey, BURN_ROUTE, "burn", prepare, (content, scope) => {
      checkBurnRevisions(scope, owner, content, body);
      const frozen = source === undefined ? undefined : scope.mediaAssets.get(owner, source.id);
      // The inspected file must still be there, unchanged, when the request is frozen.
      if (frozen === undefined || frozen.availability !== "available" || frozen.fingerprint !== source?.fingerprint) {
        throw amberError("media_missing", "the video to export subtitles with is no longer available");
      }
      return canonicalJson(
        burnTaskRequestSchema.parse({
          requestSchemaVersion: 2,
          kind: "burn",
          mode: body.mode,
          revisionId: body.revisionId,
          ...(body.translationRevisionId === undefined ? {} : { translationRevisionId: body.translationRevisionId }),
          source: { assetId: frozen.id, ...(frozen.fingerprint === undefined ? {} : { fingerprint: frozen.fingerprint }) },
          delivery,
          container,
          style,
        }),
      );
    });
  }

  /** The low-water gate of new work on each volume it writes to. */
  private async checkDisks(disks: readonly DiskUsageProbe[]): Promise<void> {
    for (const disk of disks) {
      const low = await diskLowError(disk, this.options.settings.effective());
      if (low !== undefined) {
        throw new AmberError(low, "disk below the low-water mark");
      }
    }
  }

  private async create(
    principal: RequestPrincipal,
    contentId: string,
    body: CacheMediaRequest | BurnRequest,
    idempotencyKey: string | undefined,
    route: string,
    kind: TaskKind,
    /** Checks that only run for a new request, never for a replay: disk space, source inspection. */
    precheck: () => Promise<void>,
    requestJsonFor: (content: Content, scope: RepositoryScope) => string,
  ): Promise<IdempotentResult<TaskAcceptedDto>> {
    const owner = principal.userId;
    const context = { userId: owner, route, key: idempotencyKey, requestDigest: jsonRequestDigest({ contentId, body }) };
    const replay = this.options.repository.withTransaction((scope) =>
      idempotencyKey === undefined ? undefined : scope.idempotency.get(owner, route, idempotencyKey),
    );
    if (replay === undefined) {
      await precheck();
    }
    const result = transact(this.options.repository, this.options.bus, (scope, outbox) =>
      runIdempotent(scope, context, this.now(), () => {
        const content = scope.contents.get(owner, contentId);
        if (content === undefined) {
          throw amberError("not_found", `content ${contentId}`);
        }
        const requestJson = requestJsonFor(content, scope);
        const candidate = { id: "", kind, requestJson };
        const others = scope.tasks
          .listByContent(owner, contentId)
          .filter((task) => !isTerminalProjection(task.statusProjection))
          .map((task) => ({ task, keys: laneKeys(task, content.source.kind) }));
        if (laneConflict(laneKeys(candidate, content.source.kind), others) !== undefined) {
          throw amberError("conflict", "another unfinished task works on the same stages", { code: "conflict.mutation_lane" });
        }
        const task = createTask(scope, outbox, {
          task: { id: this.newId(), userId: owner, contentId, kind, requestJson, createdAt: this.now() },
          sourceKind: content.source.kind,
          newId: this.newId,
        });
        return { status: 202, body: { taskId: task.id }, resourceRefs: [task.id] };
      }),
    );
    if (!result.replayed) {
      this.options.control.kick();
    }
    return result;
  }
}

/**
 * Both revisions belong to the Content, the original is not itself a translation, and a
 * translation is one of that original — the checks subtitle export makes.
 */
function checkBurnRevisions(scope: RepositoryScope, owner: string, content: Content, body: BurnRequest): void {
  const revision = scope.transcripts.getRevision(owner, body.revisionId);
  if (revision === undefined || revision.contentId !== content.id) {
    throw amberError("not_found", "transcript revision not found");
  }
  if (revision.kind === "translated") {
    throw amberError("invalid_request", "burn the translation through translationRevisionId", { params: { detail: "revisionId" } });
  }
  if (body.translationRevisionId !== undefined) {
    const translation = scope.transcripts.getRevision(owner, body.translationRevisionId);
    if (translation === undefined || translation.contentId !== content.id) {
      throw amberError("not_found", "transcript revision not found");
    }
    if (translation.kind !== "translated" || translation.parentRevisionId !== revision.id) {
      throw amberError("invalid_request", "the translation is not a translation of the burned revision", { params: { detail: "translationRevisionId" } });
    }
  }
}
