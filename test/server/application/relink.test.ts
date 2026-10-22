import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HmacFileGrantVerifier, signFileGrant } from "../../../src/server/adapters/file-grant/hmac-file-grant.ts";
import { RelinkService } from "../../../src/server/application/relink.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import type { MediaAsset } from "../../../src/server/domain/media-asset.ts";
import { FairSemaphore } from "../../../src/server/pipeline/fair-semaphore.ts";
import { importedTranscript, parseTimedSubtitle } from "../../../src/server/domain/subtitle-file.ts";
import type { LocalMediaIngest, MediaProbe } from "../../../src/server/ports/local-media-ingest.ts";
import { FILE_GRANT_TTL_MS } from "../../../src/shared/defaults.ts";
import type { FileGrant } from "../../../src/shared/dto/local-media.ts";
import { BOB, createHarness, createLocalContent, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";

const signal = new AbortController().signal;
const ORIGINAL = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251));

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Probes like the real ingest as far as relink cares: a whole-file fingerprint, plus a hook run after hashing. */
class FakeIngest implements Pick<LocalMediaIngest, "probe"> {
  probes: string[] = [];
  afterProbe: (path: string) => void = () => undefined;

  async probe(path: string): Promise<MediaProbe> {
    this.probes.push(path);
    const fingerprint = sha256(await readFile(path));
    this.afterProbe(path);
    return { durationMs: 61_000, hasAudio: true, mimeType: "video/mp4", fingerprint };
  }
}

interface Setup {
  h: Harness;
  ingest: FakeIngest;
  relink: RelinkService;
  key: Buffer;
  dir: string;
  contentId: string;
  asset: MediaAsset;
  revisionId: string;
  grant(path: string, purpose?: FileGrant["purpose"]): FileGrant;
  write(name: string, bytes?: Buffer): string;
  stored(): MediaAsset | undefined;
}

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

function setup(overrides: Partial<MediaAsset> = {}, options: { fingerprint?: boolean; heavy?: Pick<FairSemaphore, "run"> } = {}): Setup {
  const h = createHarness();
  open.push(h);
  const key = randomBytes(32);
  const ingest = new FakeIngest();
  const relink = new RelinkService({
    repository: h.repository,
    ingest: ingest as unknown as LocalMediaIngest,
    grants: new HmacFileGrantVerifier(key),
    ...(options.heavy === undefined ? {} : { heavy: options.heavy }),
  });
  const dir = join(h.dir, "user-files");
  mkdirSync(dir);
  const contentId = createLocalContent(h);
  const asset: MediaAsset = {
    id: h.newId(),
    userId: LOCAL.userId,
    contentId,
    kind: "external_local",
    storageRef: join(dir, "moved-away.mp4"),
    displayName: "lecture.mp4",
    mimeType: "application/octet-stream",
    sizeBytes: ORIGINAL.length,
    fingerprint: sha256(ORIGINAL),
    availability: "missing",
    retentionPolicy: "never_delete",
    createdAt: 1,
    ...overrides,
  };
  if (options.fingerprint === false) {
    delete asset.fingerprint;
  }
  const revisionId = h.newId();
  h.repository.withTransaction((scope) => {
    scope.mediaAssets.insert(asset);
    const { revision, segments } = importedTranscript({
      revisionId,
      contentId,
      language: "en",
      subtitle: parseTimedSubtitle("1\n00:00:00,000 --> 00:00:02,000\nhello\n"),
      newId: h.newId,
      createdAt: 1,
    });
    scope.transcripts.insertRevision(LOCAL.userId, revision, segments);
    scope.contents.setPrimaryTranscript(LOCAL.userId, contentId, revisionId, 1);
  });
  return {
    h,
    ingest,
    relink,
    key,
    dir,
    contentId,
    asset,
    revisionId,
    grant: (path, purpose = "relink") => signFileGrant(key, { path, purpose, expiresAt: Date.now() + FILE_GRANT_TTL_MS }),
    write(name, bytes = ORIGINAL) {
      const path = join(dir, name);
      writeFileSync(path, bytes);
      return path;
    },
    stored: () => h.repository.withTransaction((scope) => scope.mediaAssets.get(LOCAL.userId, asset.id)),
  };
}

async function errorOf(work: Promise<unknown>): Promise<{ class: string; code: string }> {
  try {
    await work;
  } catch (error) {
    if (isAmberError(error)) {
      return { class: error.appError.class, code: error.appError.code };
    }
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("RelinkService", () => {
  it("points the asset at the picked file; Content, Transcript and ids stay as they were", async () => {
    const s = setup();
    const path = s.write("found again.mp4");
    const dto = await s.relink.relink(LOCAL, s.asset.id, { path, grant: s.grant(path) }, signal);
    expect(dto).toEqual({
      id: s.asset.id,
      localPath: path,
      kind: "external_local",
      displayName: "lecture.mp4",
      mimeType: "video/mp4",
      sizeBytes: ORIGINAL.length,
      durationMs: 61_000,
      availability: "available",
      retentionPolicy: "never_delete",
      createdAt: 1,
    });
    expect(s.stored()).toEqual({ ...s.asset, storageRef: path, availability: "available", mimeType: "video/mp4", durationMs: 61_000 });
    s.h.repository.withTransaction((scope) => {
      expect(scope.contents.get(LOCAL.userId, s.contentId)?.primaryTranscriptRevisionId).toBe(s.revisionId);
      expect(scope.transcripts.listRevisions(LOCAL.userId, s.contentId).map((revision) => revision.id)).toEqual([s.revisionId]);
      expect(scope.mediaAssets.listByContent(LOCAL.userId, s.contentId).map((asset) => asset.id)).toEqual([s.asset.id]);
    });
    expect(s.ingest.probes).toEqual([path]);
  });

  it("probes the picked file holding a heavy-job slot in the user's foreground group", async () => {
    const governor = new FairSemaphore(() => 1);
    const groups: string[] = [];
    const heavy: Pick<FairSemaphore, "run"> = {
      run: (ref, runSignal, work) => {
        groups.push(ref.key);
        return governor.run(ref, runSignal, work);
      },
    };
    const s = setup({}, { heavy });
    const path = s.write("found again.mp4");
    const release = await governor.acquire({ key: "task:other", createdAt: 0 }, signal);
    const relinked = s.relink.relink(LOCAL, s.asset.id, { path, grant: s.grant(path) }, signal);
    await vi.waitFor(() => expect(groups).toEqual([`foreground:${LOCAL.userId}`]));
    // The only slot is taken: the probe waits for it.
    expect(s.ingest.probes).toEqual([]);
    let heldWhileProbing = 0;
    s.ingest.afterProbe = () => {
      heldWhileProbing = governor.inFlight;
    };
    release();
    await relinked;
    expect(s.ingest.probes).toEqual([path]);
    expect(heldWhileProbing).toBe(1);
    expect(governor.inFlight).toBe(0);
  });

  it("records the fingerprint when none was recorded", async () => {
    const s = setup({}, { fingerprint: false });
    const other = Buffer.from("other bytes of another length");
    const path = s.write("other.mp4", other);
    await s.relink.relink(LOCAL, s.asset.id, { path, grant: s.grant(path) }, signal);
    expect(s.stored()).toMatchObject({ storageRef: path, availability: "available", fingerprint: sha256(other), sizeBytes: other.length });
  });

  it("rejects a missing, forged, expired or foreign-purpose grant as unauthenticated.file_grant before touching the file", async () => {
    const s = setup();
    const path = s.write("found.mp4");
    const elsewhere = s.write("elsewhere.mp4");
    const expired = signFileGrant(s.key, { path, purpose: "relink", expiresAt: Date.now() - 1 });
    const forged = signFileGrant(randomBytes(32), { path, purpose: "relink", expiresAt: Date.now() + FILE_GRANT_TTL_MS });
    for (const grant of [forged, expired, s.grant(path, "local_file"), s.grant(path, "burn_output"), s.grant(elsewhere), { ...s.grant(path), sig: "AAAA" }]) {
      expect(await errorOf(s.relink.relink(LOCAL, s.asset.id, { path, grant }, signal))).toEqual({ class: "unauthenticated", code: "unauthenticated.file_grant" });
    }
    expect(s.ingest.probes).toEqual([]);
    expect(s.stored()).toEqual(s.asset);
  });

  it("answers not_found for an unknown or foreign asset and conflict for anything but external_local", async () => {
    const s = setup();
    const path = s.write("found.mp4");
    expect((await errorOf(s.relink.relink(LOCAL, "01UNKNOWNASSET0000000000000", { path, grant: s.grant(path) }, signal))).class).toBe("not_found");
    expect((await errorOf(s.relink.relink(BOB, s.asset.id, { path, grant: s.grant(path) }, signal))).class).toBe("not_found");
    for (const kind of ["managed_upload", "platform_cache"] as const) {
      const other = setup({ kind, storageRef: "assets/local/c/a", retentionPolicy: kind === "managed_upload" ? "keep" : "evictable" });
      const picked = other.write("found.mp4");
      expect((await errorOf(other.relink.relink(LOCAL, other.asset.id, { path: picked, grant: other.grant(picked) }, signal))).class).toBe("conflict");
      expect(other.stored()).toEqual(other.asset);
    }
    expect(s.ingest.probes).toEqual([]);
  });

  it("answers not_found for the original of a Content in the trash", async () => {
    const s = setup();
    const path = s.write("found.mp4");
    s.h.repository.withTransaction((scope) => scope.contents.trash(LOCAL.userId, s.contentId, Date.now()));
    expect((await errorOf(s.relink.relink(LOCAL, s.asset.id, { path, grant: s.grant(path) }, signal))).class).toBe("not_found");
    expect(s.ingest.probes).toEqual([]);
    expect(s.stored()).toEqual(s.asset);
  });

  it("rejects a relative path, a directory and a missing file as invalid_request", async () => {
    const s = setup();
    for (const path of ["relative/file.mp4", s.dir, join(s.dir, "absent.mp4")]) {
      expect(await errorOf(s.relink.relink(LOCAL, s.asset.id, { path, grant: s.grant(path) }, signal))).toEqual({ class: "invalid_request", code: "invalid_request" });
    }
    expect(s.stored()).toEqual(s.asset);
  });

  it("is media_changed when the picked file differs from the recorded fingerprint, and writes nothing", async () => {
    const s = setup();
    const path = s.write("different.mp4", Buffer.from(ORIGINAL).fill(7, 0, 1));
    expect((await errorOf(s.relink.relink(LOCAL, s.asset.id, { path, grant: s.grant(path) }, signal))).class).toBe("media_changed");
    expect(s.stored()).toEqual(s.asset);
  });

  it("hashes the whole file again before committing: a same-size replacement after the probe is media_changed", async () => {
    const s = setup();
    const path = s.write("swapped.mp4");
    // The probe sees the right bytes; right after it the file is replaced by others of the same size.
    s.ingest.afterProbe = (probed) => writeFileSync(probed, Buffer.from(ORIGINAL).fill(9, ORIGINAL.length - 1));
    expect((await errorOf(s.relink.relink(LOCAL, s.asset.id, { path, grant: s.grant(path) }, signal))).class).toBe("media_changed");
    expect(s.stored()).toEqual(s.asset);
  });

  it("is media_changed when the file grows between the probe and the commit", async () => {
    const s = setup({}, { fingerprint: false });
    const path = s.write("growing.mp4");
    s.ingest.afterProbe = (probed) => writeFileSync(probed, Buffer.concat([ORIGINAL, Buffer.from("tail")]));
    expect((await errorOf(s.relink.relink(LOCAL, s.asset.id, { path, grant: s.grant(path) }, signal))).class).toBe("media_changed");
    expect(s.stored()?.availability).toBe("missing");
    expect(s.stored()?.fingerprint).toBeUndefined();
  });
});
