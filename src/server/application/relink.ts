import { createHash } from "node:crypto";
import { access, constants, open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { MediaAssetDto } from "../../shared/dto/content.ts";
import type { RelinkRequest } from "../../shared/dto/local-media.ts";
import { AmberError, amberError } from "../domain/errors.ts";
import type { MediaAsset } from "../domain/media-asset.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { FairSemaphore } from "../pipeline/fair-semaphore.ts";
import type { FileGrantVerifier } from "../ports/file-grant.ts";
import type { LocalMediaIngest } from "../ports/local-media-ingest.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import { mediaAssetDto, type LocalPathResolver } from "./contents.ts";
import { visibleAsset } from "./media-assets.ts";

export interface RelinkServiceOptions {
  repository: Repository;
  ingest: LocalMediaIngest;
  grants: FileGrantVerifier;
  /**
   * The instance's managed heavy-job governor: the relink ffprobe takes a
   * slot in the user's foreground group. Without it the probe runs directly.
   */
  heavy?: Pick<FairSemaphore, "run">;
  now?: () => number;
}

/**
 * Relink answers only for `external_local` originals, whose `localPath` is the stored
 * absolute path itself; no data-directory reference is ever resolved here.
 */
const ORIGINALS_ONLY: LocalPathResolver = {
  pathOf() {
    throw new TypeError("relink resolves no data-directory references");
  },
};

function invalidPath(message: string): AmberError {
  return amberError("invalid_request", message, { params: { detail: "path" } });
}

function changed(): AmberError {
  return amberError("media_changed", "the picked file does not match the fingerprint recorded at import");
}

/** Absolute path of an existing, readable regular file; returns its size. */
async function readableFileSize(path: string): Promise<number> {
  if (!isAbsolute(path)) {
    throw invalidPath("path is not absolute");
  }
  try {
    const stats = await stat(path);
    if (!stats.isFile()) {
      throw invalidPath("path is not a regular file");
    }
    await access(path, constants.R_OK);
    return stats.size;
  } catch (error) {
    if (error instanceof AmberError) {
      throw error;
    }
    throw invalidPath("path does not name a readable file");
  }
}

/**
 * Hashes the whole file through one opened handle and reports the size that same handle
 * sees, so both numbers describe one file even if the path is swapped meanwhile.
 */
async function hashThroughHandle(path: string, signal: AbortSignal): Promise<{ fingerprint: string; sizeBytes: number }> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    throw changed();
  }
  try {
    const { size } = await handle.stat();
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
      signal.throwIfAborted();
      hash.update(chunk as Buffer);
    }
    return { fingerprint: `sha256:${hash.digest("hex")}`, sizeBytes: size };
  } finally {
    await handle.close();
  }
}

function relinkable(scope: RepositoryScope, owner: string, assetId: string): MediaAsset {
  const asset = visibleAsset(scope, owner, assetId);
  if (asset === undefined) {
    throw amberError("not_found", "media asset not found");
  }
  if (asset.kind !== "external_local") {
    throw amberError("conflict", "only a local original file can be relinked");
  }
  return asset;
}

/**
 * `PUT /api/media/:assetId/relink` [client]: points a missing
 * `external_local` original at the file the user picked, without creating a new Content.
 * Content, Transcripts and derived results keep their ids; only the asset row changes.
 */
export class RelinkService {
  private readonly options: RelinkServiceOptions;

  constructor(options: RelinkServiceOptions) {
    this.options = options;
  }

  /**
   * grant → probe (whole-file SHA-256) → compare with the recorded fingerprint → hash the
   * whole file again through one handle right before the commit. The probe and the commit
   * are seconds apart for a long video; a file replaced in between (even by one of the same
   * size) must not be linked under the old fingerprint, so the second pass is a full hash,
   * never a size check. Any mismatch is `media_changed` and nothing is written.
   */
  async relink(principal: RequestPrincipal, assetId: string, body: RelinkRequest, signal: AbortSignal): Promise<MediaAssetDto> {
    const owner = principal.userId;
    const { repository, ingest, grants } = this.options;
    if (!grants.verify(body.grant, { path: body.path, purpose: "relink" })) {
      throw amberError("unauthenticated", "file grant is missing, forged or expired", { code: "unauthenticated.file_grant" });
    }
    const recorded = repository.withTransaction((scope) => relinkable(scope, owner, assetId)).fingerprint;
    const probeSize = await readableFileSize(body.path);
    const probeFile = () => ingest.probe(body.path, signal);
    const heavy = this.options.heavy;
    const now = this.options.now ?? Date.now;
    const probe = await (heavy === undefined ? probeFile() : heavy.run({ key: `foreground:${owner}`, createdAt: now() }, signal, probeFile));
    if (recorded !== undefined && probe.fingerprint !== recorded) {
      throw changed();
    }

    const recheck = await hashThroughHandle(body.path, signal);
    if (recheck.fingerprint !== probe.fingerprint || recheck.sizeBytes !== probeSize) {
      throw changed();
    }
    signal.throwIfAborted();

    const updated = repository.withTransaction((scope) => {
      const asset = relinkable(scope, owner, assetId);
      // Another relink may have recorded a fingerprint while this one was hashing.
      if (asset.fingerprint !== recorded) {
        throw changed();
      }
      const next: MediaAsset = {
        ...asset,
        storageRef: body.path,
        availability: "available",
        mimeType: probe.mimeType,
        durationMs: probe.durationMs,
        sizeBytes: recheck.sizeBytes,
        fingerprint: probe.fingerprint,
      };
      scope.mediaAssets.update(owner, next);
      return next;
    });
    return mediaAssetDto(updated, ORIGINALS_ONLY);
  }
}
