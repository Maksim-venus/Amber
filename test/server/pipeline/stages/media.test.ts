import { copyFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mediaFixtures, type MediaFixtureName } from "../../../fixtures/media/index.ts";
import { configureAsr, LOCAL, stageRunsOf, stageStatuses, taskOf, waitFor } from "../../../fixtures/pipeline/harness.ts";
import { createMediaStack, type MediaStack } from "../../../fixtures/pipeline/media-stack.ts";
import { tempDataDir } from "../../../tools/sqlite.ts";

const open: MediaStack[] = [];
afterEach(async () => {
  for (const stack of open.splice(0)) await stack.close();
});

function stack(): MediaStack {
  const created = createMediaStack();
  open.push(created);
  return created;
}

/** Imports a private copy of a fixture so a test may move or change it. */
async function importFixture(s: MediaStack, name: MediaFixtureName, extra: { subtitle?: string } = {}) {
  const path = join(tempDataDir("amber-media-copy-"), `${name}${mediaFixtures()[name].path.slice(-4)}`);
  copyFileSync(mediaFixtures()[name].path, path);
  let initialSubtitle;
  if (extra.subtitle !== undefined) {
    const subtitlePath = join(tempDataDir("amber-sub-"), "sub.srt");
    writeFileSync(subtitlePath, extra.subtitle);
    initialSubtitle = { path: subtitlePath, grant: s.grant(subtitlePath), language: "zh-CN" };
  }
  // The configured ASR model is chosen explicitly, as the new-Task page does with a default.
  const asrModelRef = s.h.repository.withTransaction((scope) => scope.userSettings.get(LOCAL.userId)?.defaultAsrModelRef);
  const result = await s.localImport.importLocalFile(LOCAL, {
    path,
    grant: s.grant(path),
    settings: { autoProofread: false, ...(asrModelRef === undefined ? {} : { asrModelRef }) },
    allowDuplicate: true,
    ...(initialSubtitle === undefined ? {} : { initialSubtitle }),
  });
  return { path, taskId: result.body.taskIds[0] as string, contentId: result.body.contentIds[0] as string };
}

const mediaRun = (s: MediaStack, taskId: string) => stageRunsOf(s.h, taskId).find((run) => run.stage === "media");

describe("media stage", () => {
  it("probes the original, fills duration and title, and records the probed container", async () => {
    const s = stack();
    configureAsr(s.h);
    const { taskId, contentId } = await importFixture(s, "withAudio");
    s.h.scheduler.start();
    await waitFor(() => mediaRun(s, taskId)?.status === "succeeded");
    const content = s.h.repository.withTransaction((scope) => scope.contents.get(LOCAL.userId, contentId));
    expect(content?.title).toBe("withAudio");
    expect(Math.abs((content?.durationMs ?? 0) - 3000)).toBeLessThanOrEqual(100);
    const [asset] = s.h.repository.withTransaction((scope) => scope.mediaAssets.listByContent(LOCAL.userId, contentId));
    expect(asset).toMatchObject({ kind: "external_local", mimeType: "video/mp4", retentionPolicy: "never_delete" });
  });

  it("fails a file without audio with media_no_audio (never) when the task needs ASR", async () => {
    const s = stack();
    configureAsr(s.h);
    const { taskId } = await importFixture(s, "noAudio");
    s.h.scheduler.start();
    await waitFor(() => taskOf(s.h, taskId).statusProjection === "failed");
    const run = mediaRun(s, taskId);
    expect(run?.status).toBe("failed");
    expect(run?.error).toMatchObject({ class: "media_no_audio", code: "media_no_audio", retryDisposition: "never" });
    expect(stageStatuses(s.h, taskId).asr).toBe("skipped");
  });

  it("records a missing audio track as a reason when an imported subtitle makes ASR unnecessary", async () => {
    const s = stack();
    const { taskId } = await importFixture(s, "noAudio", { subtitle: "1\n00:00:00,000 --> 00:00:02,900\n字幕\n" });
    s.h.scheduler.start();
    await waitFor(() => stageStatuses(s.h, taskId).asr === "skipped");
    expect(mediaRun(s, taskId)?.status).toBe("succeeded");
    expect(JSON.parse(mediaRun(s, taskId)?.resultJson ?? "{}")).toEqual({ reasons: ["media_no_audio"] });
  });

  it("checks an imported subtitle's timeline against the probed duration and only warns", async () => {
    const s = stack();
    const { taskId } = await importFixture(s, "withAudio", { subtitle: "1\n00:00:00,000 --> 00:00:01,000\n字幕\n" });
    s.h.scheduler.start();
    await waitFor(() => stageStatuses(s.h, taskId).asr === "skipped");
    expect(mediaRun(s, taskId)?.status).toBe("succeeded");
    expect(JSON.parse(mediaRun(s, taskId)?.resultJson ?? "{}")).toEqual({ reasons: ["imported_subtitle_invalid", "subtitle_coverage_low"] });
  });

  it("accepts pure audio files", async () => {
    const s = stack();
    configureAsr(s.h);
    const { taskId, contentId } = await importFixture(s, "audioOnly");
    s.h.scheduler.start();
    await waitFor(() => mediaRun(s, taskId)?.status === "succeeded");
    const [asset] = s.h.repository.withTransaction((scope) => scope.mediaAssets.listByContent(LOCAL.userId, contentId));
    expect(asset?.mimeType).toBe("audio/mpeg");
  });

  it("fails with media_missing and marks the asset missing when the file is gone", async () => {
    const s = stack();
    const { path, taskId, contentId } = await importFixture(s, "withAudio");
    rmSync(path);
    s.h.scheduler.start();
    await waitFor(() => taskOf(s.h, taskId).statusProjection === "failed");
    expect(mediaRun(s, taskId)?.error?.code).toBe("media_missing");
    const [asset] = s.h.repository.withTransaction((scope) => scope.mediaAssets.listByContent(LOCAL.userId, contentId));
    expect(asset?.availability).toBe("missing");
  });

  it("fails with media_changed when the file no longer matches its fingerprint", async () => {
    const s = stack();
    const { path, taskId } = await importFixture(s, "withAudio");
    copyFileSync(mediaFixtures().audioOnly.path, path);
    s.h.scheduler.start();
    await waitFor(() => taskOf(s.h, taskId).statusProjection === "failed");
    expect(mediaRun(s, taskId)?.error).toMatchObject({ code: "media_changed", retryDisposition: "never" });
  });
});
