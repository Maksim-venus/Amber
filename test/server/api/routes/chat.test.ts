import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { registerProviderRoutes } from "../../../../src/server/api/routes/providers.ts";
import { ProviderService } from "../../../../src/server/application/providers.ts";
import type { LlmStreamEvent } from "../../../../src/server/domain/llm.ts";
import { chatDtoSchema, chatReplayDtoSchema, chatStreamEventSchemas, type ChatStreamEventType } from "../../../../src/shared/dto/chat.ts";
import { FakeLlmProvider, reply } from "../../../fixtures/llm/fake-llm.ts";
import { configureChatModel, seedChatContent, setContextWindow } from "../../../fixtures/pipeline/chat-data.ts";
import { BOB_TOKEN, createHarness, LOCAL, LOCAL_TOKEN, waitFor, type Harness } from "../../../fixtures/pipeline/harness.ts";

const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
const bob = { authorization: `Bearer ${BOB_TOKEN}` };
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function setup(provider = new FakeLlmProvider()) {
  const h = createHarness({ llmProviders: [provider] });
  open.push(h);
  const fixture = seedChatContent(h, 6);
  const modelRef = configureChatModel(h, 128_000);
  const providers = new ProviderService({ repository: h.repository, secrets: h.secrets, prober: h.llm, newId: h.newId });
  const { app } = await h.app({ extraRoutes: (instance) => registerProviderRoutes(instance, { providers }) });
  return { h, app, provider, modelRef, ...fixture };
}

/** `event:` / `data:` frames of an SSE body, each data validated against its schema. */
function frames(body: string): Array<{ type: ChatStreamEventType; data: unknown }> {
  return body
    .split("\n\n")
    .filter((frame) => frame.startsWith("event: "))
    .map((frame) => {
      const [eventLine, dataLine] = frame.split("\n");
      const type = (eventLine as string).slice("event: ".length) as ChatStreamEventType;
      return { type, data: chatStreamEventSchemas[type].parse(JSON.parse((dataLine as string).slice("data: ".length))) };
    });
}

describe("/api/contents/:id/chat", () => {
  it("returns the thread, its messages and the context of the chosen model", async () => {
    const { app, contentId, modelRef } = await setup();
    const url = `/api/contents/${contentId}/chat?providerProfileId=${modelRef.providerProfileId}&modelId=${modelRef.modelId}`;
    const response = await app.inject({ method: "GET", url, headers: auth });
    expect(response.statusCode).toBe(200);
    const chat = chatDtoSchema.parse(response.json());
    expect(chat).toMatchObject({ thread: null, messages: [], context: { mode: "full" } });
    expect((await app.inject({ method: "GET", url: `/api/contents/${contentId}/chat?modelId=x`, headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url, headers: bob })).statusCode).toBe(404);
  });

  it("streams an answer as SSE frames on the POST response and replays it by Idempotency-Key as JSON", async () => {
    const { app, provider, contentId, modelRef, segments } = await setup();
    provider.script({ events: reply("见 [[s1]]\n<<<suggestions>>>\n- 下一问\n- 再一问\n<<<end>>>") });
    const url = `/api/contents/${contentId}/chat/messages`;
    const headers = { ...auth, "idempotency-key": "chat-1" };
    const response = await app.inject({ method: "POST", url, headers, payload: { text: "讲了什么", modelRef } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const events = frames(response.body);
    expect(new Set(events.map((event) => event.type))).toEqual(new Set(["citation", "answer.delta", "suggestions", "usage", "done"]));
    expect(events.at(-1)).toMatchObject({ type: "done", data: { status: "complete" } });
    expect(response.body).not.toContain("<<<");
    expect(response.body).not.toMatch(/\[\[s\d/);
    expect(events.filter((event) => event.type === "answer.delta").map((event) => (event.data as { delta: string }).delta).join("")).toBe(`见 [[seg:${segments[0]?.id}]]`);

    const replay = await app.inject({ method: "POST", url, headers, payload: { text: "讲了什么", modelRef } });
    expect(replay.statusCode).toBe(200);
    expect(chatReplayDtoSchema.parse(replay.json()).message).toMatchObject({ status: "complete", suggestions: ["下一问", "再一问"] });
    expect(provider.calls).toHaveLength(1);
  });

  it("refuses with a JSON error before streaming: bad body, foreign Content, unknown context window", async () => {
    const { h, app, contentId, modelRef } = await setup();
    const url = `/api/contents/${contentId}/chat/messages`;
    expect((await app.inject({ method: "POST", url, headers: auth, payload: { text: "", modelRef } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers: auth, payload: { text: "q", modelRef, extra: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers: bob, payload: { text: "q", modelRef } })).statusCode).toBe(404);

    // Historical data: a model whose user-stated window was never filled in.
    setContextWindow(h, modelRef, undefined);
    const refused = await app.inject({ method: "POST", url, headers: auth, payload: { text: "q", modelRef } });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toMatchObject({
      class: "llm_capability",
      code: "llm_capability.context_window_unknown",
      details: { providerProfileId: modelRef.providerProfileId, modelId: modelRef.modelId },
    });
    const chosen = `providerProfileId=${modelRef.providerProfileId}&modelId=${modelRef.modelId}`;
    const get = await app.inject({ method: "GET", url: `/api/contents/${contentId}/chat?${chosen}`, headers: auth });
    expect(get.json().context).toEqual({ mode: "unavailable", reason: "context_window_unknown" });

    // Filling in the override through the provider API makes chat usable again.
    const override = await app.inject({
      method: "PUT",
      url: `/api/providers/${modelRef.providerProfileId}/models/${encodeURIComponent(modelRef.modelId)}/override`,
      headers: auth,
      payload: { limits: { contextWindowTokens: 64_000 } },
    });
    expect(override.statusCode).toBe(200);
    const accepted = await app.inject({ method: "POST", url, headers: auth, payload: { text: "q", modelRef } });
    expect(accepted.statusCode).toBe(200);
    expect(frames(accepted.body).at(-1)).toMatchObject({ type: "done", data: { status: "complete" } });
  });

  it("deletes the history with 204", async () => {
    const { app, contentId, modelRef } = await setup();
    await app.inject({ method: "POST", url: `/api/contents/${contentId}/chat/messages`, headers: auth, payload: { text: "q", modelRef } });
    expect((await app.inject({ method: "DELETE", url: `/api/contents/${contentId}/chat`, headers: bob })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/contents/${contentId}/chat`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/api/contents/${contentId}/chat`, headers: auth })).json().messages).toEqual([]);
  });

  it("marks the answer interrupted when the client disconnects mid-stream, keeping what streamed", async () => {
    const provider = new FakeLlmProvider();
    let released = false;
    provider.script(async function* (_request, opts): AsyncGenerator<LlmStreamEvent> {
      yield { type: "text_delta", delta: "第一段回答。" };
      // Waits like a slow upstream until the call is aborted.
      while (!opts.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      released = true;
      yield { type: "text_delta", delta: "不应保存" };
      yield { type: "done", stopReason: "aborted" };
    });
    const { h, app, contentId, modelRef } = await setup(provider);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;

    await new Promise<void>((resolve, reject) => {
      const body = JSON.stringify({ text: "讲一下", modelRef });
      const req = httpRequest(
        { host: "127.0.0.1", port, method: "POST", path: `/api/contents/${contentId}/chat/messages`, headers: { ...auth, "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
        (res) => {
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            if (chunk.includes("第一段回答")) {
              req.destroy();
              resolve();
            }
          });
        },
      );
      req.on("error", () => undefined);
      req.on("close", () => resolve());
      setTimeout(() => reject(new Error("no first delta")), 5_000);
      req.end(body);
    });

    const assistant = () => h.chat.get(LOCAL, contentId, {}).messages[1];
    await waitFor(() => assistant()?.status === "interrupted");
    expect(released).toBe(true);
    expect(assistant()?.text).toBe("第一段回答。");
    expect(h.repository.withTransaction((scope) => scope.tokenUsage.list(LOCAL.userId)).map((row) => row.outcome)).toEqual(["outcome_unknown"]);
  });
});
