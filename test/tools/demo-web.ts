import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmRequest, LlmStreamEvent } from "../../src/server/domain/llm.ts";
import type { LlmStreamOptions } from "../../src/server/ports/llm-provider.ts";
import { reply } from "../fixtures/llm/fake-llm.ts";
import { pipelineAnswer, pipelinePromptKind, promptText } from "../fixtures/llm/pipeline-llm.ts";
import { LOCAL_TOKEN } from "../fixtures/pipeline/harness.ts";
import { createDemoStack } from "../fixtures/pipeline/demo-stack.ts";
import { evenCues } from "../fixtures/platform/subtitles.ts";

/**
 * Browser pipeline demo for manual checking: the built SPA in a browser against the replayed pipeline
 * (platform, ASR and LLM edges scripted; nothing leaves the machine except the YouTube /
 * bilibili player iframes, which the user's browser loads itself). Stages are slowed down a
 * little so the live stage flow is visible.
 *
 *   node test/tools/demo-web.ts [--port 4180] [--no-build]
 *
 * Then open the printed URL, go to /new and paste one of the printed links.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WEB_DIR = join(ROOT, "dist/web");
const STEP_DELAY_MS = 1200;
const CHAT_DELTA_DELAY_MS = 80;

/** Public videos whose players the browser embeds; the transcript text is synthetic. */
const YOUTUBE_ID = "UF8uR6Z6KLc";
const BILIBILI_ID = "BV1CQt365EzW";
const DURATION_MS = 15 * 60_000;
const TOPICS = ["课程目标", "核心概念", "第一个例子", "常见误区", "方法对比", "动手练习", "回顾与小结", "延伸阅读"];
const lineOf = (index: number): string => `（演示字幕）第 ${index + 1} 句：${TOPICS[index % TOPICS.length]}。`;

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function buildWeb(): void {
  const vite = join(dirname(createRequire(import.meta.url).resolve("vite/package.json")), "bin/vite.js");
  const result = spawnSync(process.execPath, [vite, "build"], { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error("vite build failed");
  }
}

/** A richer summary than the test fixture, still citing only the aliases it was given. */
function demoAnswer(llmRequest: LlmRequest): string {
  if (pipelinePromptKind(llmRequest) !== "envelope") {
    return pipelineAnswer(llmRequest);
  }
  const text = promptText(llmRequest);
  const aliases = [...new Set([...text.slice(text.lastIndexOf("【逐字稿】")).matchAll(/\[\[s(\d+)\]\]|\[s(\d+)\]/g)].map((m) => Number(m[1] ?? m[2])))];
  const pick = (fraction: number): string => `[[s${aliases[Math.min(aliases.length - 1, Math.floor(aliases.length * fraction))] ?? 1}]]`;
  return [
    "## 摘要",
    `这是一段演示用的合成字幕：先交代课程目标 ${pick(0)}，再展开核心概念与例子 ${pick(0.3)}，最后回顾与小结 ${pick(0.9)}。`,
    "## 要点",
    `- 课程目标与整体安排 ${pick(0.05)}`,
    `- 第一个例子说明了核心概念如何落地 ${pick(0.35)}`,
    `- 常见误区与方法对比 ${pick(0.5)}`,
    `- 动手练习的建议 ${pick(0.7)}`,
  ].join("\n");
}

function proxyApi(target: string, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", target);
  const upstream = request(
    url,
    { method: req.method, headers: { ...req.headers, host: url.host, authorization: `Bearer ${LOCAL_TOKEN}` } },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502);
    }
    res.end();
  });
  // The browser going away must reach the backend, which then marks a streaming answer interrupted.
  res.on("close", () => {
    if (!res.writableFinished) {
      upstream.destroy();
    }
  });
  req.pipe(upstream);
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  const candidate = normalize(join(WEB_DIR, pathname));
  const file =
    candidate.startsWith(WEB_DIR + sep) && existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(WEB_DIR, "index.html");
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

async function main(): Promise<void> {
  if (!process.argv.includes("--no-build")) {
    buildWeb();
  }
  const port = Number(argValue("--port") ?? 4180);
  const stack = await createDemoStack();

  const youtube = stack.h.platforms.youtube;
  const bilibili = stack.h.platforms.bilibili;
  const cues = evenCues(40, DURATION_MS, lineOf);
  youtube.video(YOUTUBE_ID, {
    metadata: {
      title: "演示：第一讲（YouTube 播放器，合成字幕）",
      durationMs: DURATION_MS,
      rawLanguage: "zh-CN",
      subtitleTracks: [{ locator: "zh", language: "zh-CN", autoGenerated: false, translated: false }],
    },
    subtitles: { zh: cues },
  });
  bilibili.video(BILIBILI_ID, {
    metadata: {
      title: "演示：第二讲（B 站播放器，合成字幕）",
      durationMs: DURATION_MS,
      rawLanguage: "zh-CN",
      subtitleTracks: [{ locator: "zh", language: "zh-CN", autoGenerated: false, translated: false }],
    },
    subtitles: { zh: cues },
  });
  // Slow every scripted edge down a little so the stage flow can be watched.
  for (const adapter of [youtube, bilibili]) {
    const fetchMetadata = adapter.fetchMetadata.bind(adapter);
    adapter.fetchMetadata = async (...args) => {
      await delay(STEP_DELAY_MS);
      return fetchMetadata(...args);
    };
  }
  stack.llm.stream = (llmRequest: LlmRequest, opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> => {
    stack.llm.calls.push({ request: llmRequest, opts });
    const events = reply(demoAnswer(llmRequest));
    // Chat answers trickle in so streaming and the stop button can be tried by hand.
    const perEvent = pipelinePromptKind(llmRequest) === "chat" ? CHAT_DELTA_DELAY_MS : 0;
    // Like a real adapter, a cancelled call stops at once.
    return (async function* () {
      await delay(STEP_DELAY_MS, opts.signal);
      for await (const event of events) {
        if (perEvent > 0) {
          await delay(perEvent, opts.signal);
        }
        yield event;
      }
    })();
  };

  // A configured model and ASR profile with placeholder keys: the replayed edges never use them.
  const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${stack.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${LOCAL_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new Error(`${method} ${path} → ${response.status}`);
    }
    return response.json();
  };
  const provider = (await api("POST", "/api/providers", {
    name: "演示模型",
    protocol: "openai_compatible",
    baseURL: "https://llm.example.com/v1",
    models: [{ modelId: "demo-model", contextWindowTokens: 128_000 }],
  })) as { id: string };
  await api("PUT", `/api/providers/${provider.id}/credential`, { value: "<placeholder-llm-key>" });
  await api("PUT", "/api/asr-profile", { value: "<placeholder-asr-key>" });
  await api("PATCH", "/api/settings", { defaultModelRef: { providerProfileId: provider.id, modelId: "demo-model" } });

  const server = createServer((req, res) => {
    if ((req.url ?? "").startsWith("/api/")) {
      proxyApi(stack.baseUrl, req, res);
    } else {
      serveStatic(req, res);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(
      [
        "",
        `Amber browser demo: http://localhost:${port}/new`,
        "Paste one of these links (replayed, no real platform or model calls):",
        `  https://www.youtube.com/watch?v=${YOUTUBE_ID}`,
        `  https://www.bilibili.com/video/${BILIBILI_ID}`,
        "Ctrl+C to stop.",
        "",
      ].join("\n"),
    );
  });

  const stop = async (): Promise<void> => {
    server.close();
    await stack.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

/** Waits `ms`; with a signal, rejects as soon as it aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done, fail) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        fail(signal.reason);
      },
      { once: true },
    );
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
