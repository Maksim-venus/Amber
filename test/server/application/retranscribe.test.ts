import { afterEach, describe, expect, it } from "vitest";
import { registerContentRoutes } from "../../../src/server/api/routes/contents.ts";
import { RetranscribeService } from "../../../src/server/application/retranscribe.ts";
import { mediaFixtures } from "../../fixtures/media/index.ts";
import { BOB_TOKEN, LOCAL, LOCAL_TOKEN, taskOf } from "../../fixtures/pipeline/harness.ts";
import { createMediaStack, type MediaStack } from "../../fixtures/pipeline/media-stack.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: MediaStack[] = [];
afterEach(async () => {
  for (const stack of open.splice(0)) await stack.close();
});

async function setup() {
  const stack = createMediaStack();
  open.push(stack);
  const { h } = stack;
  const retranscribe = new RetranscribeService({ repository: h.repository, bus: h.bus, control: h.scheduler, disk: h.disk, settings: h.settings, newId: h.newId });
  const { app } = await h.app({ extraRoutes: (instance) => registerContentRoutes(instance, { retranscribe }) });
  const { withAudio } = mediaFixtures();
  const created = await stack.localImport.importLocalFile(LOCAL, {
    path: withAudio.path,
    grant: stack.grant(withAudio.path),
    settings: { autoProofread: false },
    allowDuplicate: true,
  });
  const contentId = created.body.contentIds[0] as string;
  // The import's own Task would hold the asr lane; this test is about the new one.
  h.tasks.cancel(LOCAL, created.body.taskIds[0] as string);
  return { stack, app, contentId, url: `/api/contents/${contentId}/transcript/retranscribe` };
}

describe("POST /api/contents/:id/transcript/retranscribe", () => {
  it("creates a single-stage retranscribe Task, replays by Idempotency-Key and refuses a second one while it is unfinished", async () => {
    const { stack, app, url } = await setup();
    const first = await app.inject({ method: "POST", url, headers: { ...auth, "idempotency-key": "k-1" }, payload: {} });
    expect(first.statusCode).toBe(202);
    const { taskId } = first.json() as { taskId: string };
    const task = taskOf(stack.h, taskId);
    expect(task).toMatchObject({ kind: "retranscribe", requestJson: '{"kind":"retranscribe","requestSchemaVersion":1}' });
    const runs = stack.h.repository.withTransaction((scope) => scope.stageRuns.listByTask(LOCAL.userId, taskId));
    expect(runs.map((run) => run.stage)).toEqual(["asr"]);

    const replay = await app.inject({ method: "POST", url, headers: { ...auth, "idempotency-key": "k-1" } });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual({ taskId });

    const second = await app.inject({ method: "POST", url, headers: auth, payload: {} });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("conflict.mutation_lane");
  });

  it("freezes only the requested ASR model, never the user's default, and refuses another user's or an unlisted one", async () => {
    const { stack, app, url } = await setup();
    const { h } = stack;
    const asrProfile = (userId: string, id: string) =>
      h.repository.withTransaction((scope) => scope.asrProfiles.insert({ id, userId, name: id, provider: "dashscope", models: [{ modelId: "fun-asr" }], createdAt: 1 }));
    asrProfile(LOCAL.userId, "mine");
    asrProfile(LOCAL.userId, "default");
    asrProfile("bob", "bobs");
    const foreign = await app.inject({ method: "POST", url, headers: auth, payload: { asrModelRef: { asrProfileId: "bobs", modelId: "fun-asr" } } });
    expect(foreign.statusCode).toBe(400);
    const unlisted = await app.inject({ method: "POST", url, headers: auth, payload: { asrModelRef: { asrProfileId: "mine", modelId: "scribe_v2" } } });
    expect(unlisted.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers: auth, payload: { asrProfileId: "mine" } })).statusCode).toBe(400);

    const chosen = await app.inject({ method: "POST", url, headers: auth, payload: { asrModelRef: { asrProfileId: "mine", modelId: "fun-asr" } } });
    expect(chosen.statusCode).toBe(202);
    const chosenId = (chosen.json() as { taskId: string }).taskId;
    expect(JSON.parse(taskOf(h, chosenId).requestJson)).toEqual({
      kind: "retranscribe",
      requestSchemaVersion: 1,
      asrModelRef: { asrProfileId: "mine", modelId: "fun-asr" },
    });
    h.tasks.cancel(LOCAL, chosenId);

    // The default only preselects the picker; a request without a model waits for one.
    h.userSettings.patch(LOCAL, { defaultAsrModelRef: { asrProfileId: "default", modelId: "fun-asr" } });
    const unchosen = await app.inject({ method: "POST", url, headers: auth });
    expect(JSON.parse(taskOf(h, (unchosen.json() as { taskId: string }).taskId).requestJson)).toEqual({ kind: "retranscribe", requestSchemaVersion: 1 });
  });

  it("answers 404 for an unknown or foreign Content, 400 for options and 422 media_missing without media", async () => {
    const { stack, app, contentId, url } = await setup();
    expect((await app.inject({ method: "POST", url: "/api/contents/nope/transcript/retranscribe", headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url, headers: bob })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url, headers: auth, payload: { language: "en" } })).statusCode).toBe(400);

    stack.h.repository.withTransaction((scope) => {
      for (const asset of scope.mediaAssets.listByContent(LOCAL.userId, contentId)) {
        scope.mediaAssets.update(LOCAL.userId, { ...asset, availability: "missing" });
      }
    });
    const missing = await app.inject({ method: "POST", url, headers: auth });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.code).toBe("media_missing");
  });

  it("is refused below the disk low-water mark", async () => {
    const { stack, app, url } = await setup();
    stack.h.disk.low();
    const low = await app.inject({ method: "POST", url, headers: auth });
    expect(low.statusCode).toBe(507);
    expect(low.json().error.code).toBe("disk_low");
  });
});
