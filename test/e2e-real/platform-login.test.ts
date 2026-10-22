import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import QRCode from "qrcode";
import { afterAll, describe, expect, it } from "vitest";
import { DirectOutboundHttpClient } from "../../src/server/adapters/outbound-http/direct.ts";
import { BilibiliAdapter } from "../../src/server/adapters/platform/bilibili/index.ts";
import { BilibiliQrLogin } from "../../src/server/adapters/platform/bilibili/qr-login.ts";
import { YtDlp } from "../../src/server/adapters/platform/yt-dlp.ts";
import { NodeProcessRunner } from "../../src/server/adapters/process-runner/node-process-runner.ts";
import { PlatformAccountService } from "../../src/server/application/platform-accounts.ts";
import { PlatformQrLoginService } from "../../src/server/application/platform-qr-login.ts";
import { PlatformRegistry } from "../../src/server/application/platforms.ts";
import type { OutboundHttpClient, OutboundRequest, OutboundResponse } from "../../src/server/ports/outbound-http.ts";
import { childProcessEnv } from "../../src/server/ports/process-runner.ts";
import { QR_ATTEMPT_TTL_MS, QR_POLL_INTERVAL_MS } from "../../src/shared/defaults.ts";
import type { PlatformQrStatus } from "../../src/shared/enums.ts";
import { createHarness, LOCAL, type Harness } from "../fixtures/pipeline/harness.ts";
import { toolsBinDir } from "../fixtures/tools.ts";

/**
 * Real bilibili QR login. Runs only with `AMBER_E2E_PLATFORM=1` and a per-run approval
 * (no paid call without the env switch and per-run approval); a person scans the code
 * with the bilibili app. The code is written as an HTML page into a temporary directory
 * whose path goes to stderr; the page and directory are removed afterwards.
 * `AMBER_E2E_RECORD_DIR` (optional) receives the platform's answers per state with every
 * token, URL and cookie value replaced.
 *
 * The second test leaves a code unscanned: Amber's attempt lapses after
 * `QR_ATTEMPT_TTL_MS`, then the platform is asked until it calls the code expired too,
 * which records that answer and the code's observed lifetime.
 *
 * Nothing here prints cookies, the code's URL or its key.
 */

const enabled = process.env["AMBER_E2E_PLATFORM"] === "1";
/** How long past Amber's own lifetime the platform gets to call a code expired. */
const PLATFORM_EXPIRY_MARGIN_MS = 60_000;
const TEST_TIMEOUT_MS = QR_ATTEMPT_TTL_MS + PLATFORM_EXPIRY_MARGIN_MS + 120_000;
const REDACTED = "<redacted>";

/** Holds the page with the code; made only when a code is shown. */
let scratch: string | undefined;
afterAll(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

function record(name: string, value: unknown): void {
  const dir = process.env["AMBER_E2E_RECORD_DIR"];
  if (dir !== undefined && dir !== "") {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
  }
}

/** A `Set-Cookie` header with its value replaced; name and attributes stay. */
function redactedSetCookie(header: string): string {
  const [pair = "", ...attributes] = header.split(";");
  const name = pair.slice(0, Math.max(0, pair.indexOf("="))).trim();
  return [`${name}=${REDACTED}`, ...attributes.map((attribute) => attribute.trim())].join("; ");
}

/** A passport answer fit for a fixture: tokens, URLs and timestamps replaced. */
function redactedEnvelope(body: unknown): unknown {
  if (body === null || typeof body !== "object") {
    return body;
  }
  const envelope = body as { data?: Record<string, unknown> };
  if (envelope.data === undefined || envelope.data === null) {
    return body;
  }
  const data = Object.fromEntries(
    Object.entries(envelope.data).map(([key, value]) =>
      ["url", "qrcode_key", "refresh_token"].includes(key) && value !== "" ? [key, REDACTED] : key === "timestamp" ? [key, 0] : [key, value],
    ),
  );
  return { ...envelope, data };
}

const POLL_STATES: Readonly<Record<number, PlatformQrStatus>> = { 86101: "pending", 86090: "scanned", 0: "confirmed", 86038: "expired" };

/**
 * Passes requests through to the real client and keeps a redacted copy of the passport's
 * answers, one per state, plus the poll key so an attempt can be followed past Amber's
 * own lifetime. The key stays in memory.
 */
class RecordingHttp implements OutboundHttpClient {
  readonly inner = new DirectOutboundHttpClient();
  readonly recorded = new Map<string, unknown>();
  lastPollKey: string | undefined;

  async request(request: OutboundRequest): Promise<OutboundResponse> {
    const response = await this.inner.request(request);
    const text = await response.text();
    const url = new URL(request.url);
    if (url.host === "passport.bilibili.com") {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      const setCookies = (response.setCookies ?? []).map(redactedSetCookie);
      const answer = { status: response.status, body: redactedEnvelope(body), ...(setCookies.length === 0 ? {} : { setCookies }) };
      if (url.pathname.endsWith("/generate")) {
        this.recorded.set("generate", answer);
      } else if (url.pathname.endsWith("/poll")) {
        this.lastPollKey = url.searchParams.get("qrcode_key") ?? undefined;
        const code = (body as { data?: { code?: number } } | undefined)?.data?.code;
        const state = code === undefined ? undefined : POLL_STATES[code];
        if (state !== undefined) this.recorded.set(state, answer);
      }
    }
    const replay = (async function* () {
      yield new TextEncoder().encode(text);
    })();
    return { status: response.status, headers: response.headers, ...(response.setCookies === undefined ? {} : { setCookies: response.setCookies }), body: replay, text: async () => text };
  }

  save(recordedWith: string, extra: Record<string, unknown> = {}): void {
    for (const [state, answer] of this.recorded) {
      record(`bilibili-qr-${state}.json`, {
        source: { url: "https://passport.bilibili.com/x/passport-login/web/qrcode", recordedAt: new Date().toISOString().slice(0, 10), recordedWith, ...extra },
        answer,
      });
    }
  }
}

function stack(h: Harness) {
  const http = new RecordingHttp();
  const ytDlp = new YtDlp({
    runner: new NodeProcessRunner(),
    binDir: toolsBinDir(["yt-dlp", "deno", "ffmpeg"]),
    dataDir: h.dir,
    env: childProcessEnv(process.env),
  });
  const adapter = new BilibiliAdapter({ ytDlp, http });
  const accounts = new PlatformAccountService({ repository: h.repository, secrets: h.secrets, platforms: new PlatformRegistry([adapter]), newId: h.newId });
  const qrLogin = new BilibiliQrLogin({ http });
  const service = new PlatformQrLoginService({ logins: [qrLogin], accounts, newId: h.newId });
  return { http, accounts, qrLogin, service };
}

async function showCode(qrUrl: string): Promise<void> {
  const svg = await QRCode.toString(qrUrl, { type: "svg", margin: 2, width: 320 });
  scratch ??= mkdtempSync(join(tmpdir(), "amber-e2e-qr-"));
  const page = join(scratch, "bilibili-qr.html");
  writeFileSync(page, `<!doctype html><meta charset="utf-8"><title>Amber QR login</title><body style="display:grid;place-items:center;height:100vh;margin:0">${svg}</body>`, { mode: 0o600 });
  process.stderr.write(`\n[amber-e2e] scan the code in ${page} with the bilibili app\n`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const signal = (): AbortSignal => AbortSignal.timeout(60_000);

describe.skipIf(!enabled)("real bilibili QR login", () => {
  it(
    "is confirmed by a scan, stores the login only then, and checks valid",
    async () => {
      const h = createHarness();
      try {
        const { http, accounts, service } = stack(h);
        const attempt = await service.start(LOCAL, "bilibili", signal());
        await showCode(attempt.qrUrl);
        const seen: PlatformQrStatus[] = [];
        let status: PlatformQrStatus = "pending";
        while (status === "pending" || status === "scanned") {
          await sleep(QR_POLL_INTERVAL_MS);
          status = (await service.status(LOCAL, "bilibili", attempt.attemptId, signal())).status;
          if (seen.at(-1) !== status) {
            seen.push(status);
            process.stderr.write(`[amber-e2e] ${status}\n`);
          }
          if (status === "pending" || status === "scanned") {
            expect(h.repository.withTransaction((scope) => scope.platformAccounts.get(LOCAL.userId, "bilibili"))).toBeUndefined();
          }
        }
        http.save("Amber BilibiliQrLogin over the direct client; a real scan and confirmation");
        expect(status).toBe("confirmed");
        expect(h.repository.withTransaction((scope) => scope.platformAccounts.get(LOCAL.userId, "bilibili"))).toMatchObject({ status: "valid" });
        expect(await accounts.check(LOCAL, "bilibili", signal())).toEqual({ status: "valid" });
        const cookieNames = (await accounts.credentialFor(LOCAL.userId, "bilibili")?.cookies())
          ?.split("\n")
          .filter((line) => line !== "" && !line.startsWith("# "))
          .map((line) => line.split("\t")[5]);
        process.stderr.write(`[amber-e2e] states ${seen.join(" → ")}; stored cookie names ${cookieNames?.join(", ")}\n`);
      } finally {
        await h.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "lapses when nobody scans, and stays expired",
    async () => {
      const h = createHarness();
      try {
        const { http, qrLogin, service } = stack(h);
        const issuedAt = Date.now();
        const attempt = await service.start(LOCAL, "bilibili", signal());
        let status: PlatformQrStatus = "pending";
        while (status !== "expired") {
          await sleep(QR_POLL_INTERVAL_MS);
          status = (await service.status(LOCAL, "bilibili", attempt.attemptId, signal())).status;
          expect(status === "pending" || status === "expired").toBe(true);
        }
        // Amber's attempt is over; follow the code until the platform says so as well.
        const key = http.lastPollKey;
        let platformExpiredAfterMs: number | undefined = http.recorded.has("expired") ? Date.now() - issuedAt : undefined;
        while (platformExpiredAfterMs === undefined && key !== undefined && Date.now() - issuedAt < QR_ATTEMPT_TTL_MS + PLATFORM_EXPIRY_MARGIN_MS) {
          await sleep(QR_POLL_INTERVAL_MS);
          if ((await qrLogin.poll(key, signal())).status === "expired") platformExpiredAfterMs = Date.now() - issuedAt;
        }
        process.stderr.write(`[amber-e2e] platform called the code expired after ${String(platformExpiredAfterMs)} ms\n`);
        http.save("Amber BilibiliQrLogin over the direct client; a code left unscanned", { observedLifetimeMs: platformExpiredAfterMs });
        expect(platformExpiredAfterMs).toBeDefined();
        await sleep(QR_POLL_INTERVAL_MS);
        expect(await service.status(LOCAL, "bilibili", attempt.attemptId, signal())).toEqual({ status: "expired" });
        expect(h.repository.withTransaction((scope) => scope.platformAccounts.get(LOCAL.userId, "bilibili"))).toBeUndefined();
      } finally {
        await h.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
