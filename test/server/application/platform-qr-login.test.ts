import { afterEach, describe, expect, it } from "vitest";
import { BilibiliQrLogin } from "../../../src/server/adapters/platform/bilibili/qr-login.ts";
import { PlatformQrLoginService } from "../../../src/server/application/platform-qr-login.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { parseNetscapeCookies } from "../../../src/server/domain/platform-cookie.ts";
import { OutboundHttpError } from "../../../src/server/ports/outbound-http.ts";
import { QR_ATTEMPT_TTL_MS, QR_POLL_INTERVAL_MS } from "../../../src/shared/defaults.ts";
import { GENERATE, POLL_CONFIRMED, POLL_EXPIRED, POLL_PENDING, POLL_SCANNED, QR_URL } from "../../fixtures/platform/bilibili-qr.ts";
import { ScriptedHttp, signal, type ScriptedResponse } from "../../fixtures/platform/scripted-io.ts";
import { BOB, createHarness, gate, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";
import { countRows } from "../../tools/sqlite.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

/**
 * The service over the real bilibili adapter, the platform answering polls from `answers`
 * in order (the last one repeats) and a clock the test moves.
 */
function setup(answers: Array<ScriptedResponse | Error | (() => Promise<ScriptedResponse>)>) {
  const h = createHarness();
  open.push(h);
  const clock = { now: 1_800_000_000_000 };
  let polls = 0;
  const http = new ScriptedHttp(async (request) => {
    if (new URL(request.url).pathname.endsWith("/generate")) return GENERATE;
    const answer = answers[Math.min(polls, answers.length - 1)] as ScriptedResponse | Error | (() => Promise<ScriptedResponse>);
    polls += 1;
    return typeof answer === "function" ? answer() : answer;
  });
  const service = new PlatformQrLoginService({
    logins: [new BilibiliQrLogin({ http, now: () => clock.now })],
    accounts: h.platformAccounts,
    now: () => clock.now,
    newId: h.newId,
  });
  const tick = (ms = QR_POLL_INTERVAL_MS): void => {
    clock.now += ms;
  };
  return { h, service, http, clock, tick, polls: () => http.to("/x/passport-login/web/qrcode/poll").length };
}

const accountOf = (h: Harness, userId = LOCAL.userId) => h.repository.withTransaction((scope) => scope.platformAccounts.get(userId, "bilibili"));

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isAmberError(error)) return error.appError.code;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("PlatformQrLoginService", () => {
  it("walks pending → scanned → confirmed and creates the account only once confirmed", async () => {
    const s = setup([POLL_PENDING, POLL_SCANNED, POLL_CONFIRMED]);
    const attempt = await s.service.start(LOCAL, "bilibili", signal());
    expect(attempt).toEqual({ attemptId: expect.any(String), qrUrl: QR_URL, expiresAt: s.clock.now + QR_ATTEMPT_TTL_MS });

    // Within the interval the platform is not asked again.
    expect(await s.service.status(LOCAL, "bilibili", attempt.attemptId, signal())).toEqual({ status: "pending" });
    expect(s.polls()).toBe(0);

    s.tick();
    expect(await s.service.status(LOCAL, "bilibili", attempt.attemptId, signal())).toEqual({ status: "pending" });
    s.tick();
    expect(await s.service.status(LOCAL, "bilibili", attempt.attemptId, signal())).toEqual({ status: "scanned" });
    expect(accountOf(s.h)).toBeUndefined();
    expect(countRows(s.h.db, "platform_account")).toBe(0);

    s.tick();
    expect(await s.service.status(LOCAL, "bilibili", attempt.attemptId, signal())).toEqual({ status: "confirmed" });
    expect(accountOf(s.h)).toMatchObject({ status: "valid", checkedAt: expect.any(Number) });
    const stored = await s.h.platformAccounts.credentialFor(LOCAL.userId, "bilibili")?.cookies();
    expect(parseNetscapeCookies(stored ?? "").map((cookie) => cookie.name)).toContain("SESSDATA");
    expect(s.h.platformAccounts.list(LOCAL).accounts[0]).toMatchObject({ hasCredential: true, status: "valid" });

    // Over: answered from memory, the platform is never asked again.
    s.tick();
    expect(await s.service.status(LOCAL, "bilibili", attempt.attemptId, signal())).toEqual({ status: "confirmed" });
    expect(s.polls()).toBe(3);
  });

  it("stays expired once the platform says so, until a new code is requested", async () => {
    const s = setup([POLL_EXPIRED, POLL_PENDING]);
    const attempt = await s.service.start(LOCAL, "bilibili", signal());
    s.tick();
    expect(await s.service.status(LOCAL, "bilibili", attempt.attemptId, signal())).toEqual({ status: "expired" });
    s.tick();
    expect(await s.service.status(LOCAL, "bilibili", attempt.attemptId, signal())).toEqual({ status: "expired" });
    expect(s.polls()).toBe(1);
    expect(accountOf(s.h)).toBeUndefined();
    const next = await s.service.start(LOCAL, "bilibili", signal());
    s.tick();
    expect(await s.service.status(LOCAL, "bilibili", next.attemptId, signal())).toEqual({ status: "pending" });
  });

  it("expires at expiresAt without asking the platform", async () => {
    const s = setup([POLL_PENDING]);
    const attempt = await s.service.start(LOCAL, "bilibili", signal());
    s.tick(QR_ATTEMPT_TTL_MS);
    expect(await s.service.status(LOCAL, "bilibili", attempt.attemptId, signal())).toEqual({ status: "expired" });
    expect(s.polls()).toBe(0);
  });

  it("keeps one attempt per user: the replaced one answers expired, unknown and other users' ids are 404", async () => {
    const s = setup([POLL_PENDING]);
    const first = await s.service.start(LOCAL, "bilibili", signal());
    const second = await s.service.start(LOCAL, "bilibili", signal());
    expect(second.attemptId).not.toBe(first.attemptId);
    s.tick();
    expect(await s.service.status(LOCAL, "bilibili", first.attemptId, signal())).toEqual({ status: "expired" });
    expect(await s.service.status(LOCAL, "bilibili", second.attemptId, signal())).toEqual({ status: "pending" });
    expect(await codeOf(s.service.status(LOCAL, "bilibili", "01UNKNOWNATTEMPT0000000000", signal()))).toBe("not_found");
    expect(await codeOf(s.service.status(BOB, "bilibili", second.attemptId, signal()))).toBe("not_found");
    expect(await codeOf(s.service.status(LOCAL, "youtube", second.attemptId, signal()))).toBe("not_found");
    expect(await codeOf(s.service.start(LOCAL, "youtube", signal()))).toBe("not_found");
  });

  it("shares one platform request among concurrent polls", async () => {
    const release = gate();
    const s = setup([
      async () => {
        await release.promise;
        return POLL_SCANNED;
      },
    ]);
    const attempt = await s.service.start(LOCAL, "bilibili", signal());
    s.tick();
    const both = Promise.all([
      s.service.status(LOCAL, "bilibili", attempt.attemptId, signal()),
      s.service.status(LOCAL, "bilibili", attempt.attemptId, signal()),
    ]);
    release.open();
    expect(await both).toEqual([{ status: "scanned" }, { status: "scanned" }]);
    expect(s.polls()).toBe(1);
  });

  it("keeps the last status through network trouble and risk control", async () => {
    const s = setup([POLL_SCANNED, new OutboundHttpError("before_send", "network"), { status: 412 }, POLL_SCANNED]);
    const attempt = await s.service.start(LOCAL, "bilibili", signal());
    for (let poll = 0; poll < 4; poll += 1) {
      s.tick();
      expect(await s.service.status(LOCAL, "bilibili", attempt.attemptId, signal())).toEqual({ status: "scanned" });
    }
    expect(s.polls()).toBe(4);
  });

  it("drops a confirmation that arrives after the attempt was replaced", async () => {
    const release = gate();
    const s = setup([
      async () => {
        await release.promise;
        return POLL_CONFIRMED;
      },
      POLL_PENDING,
    ]);
    const attempt = await s.service.start(LOCAL, "bilibili", signal());
    s.tick();
    const late = s.service.status(LOCAL, "bilibili", attempt.attemptId, signal());
    await s.service.start(LOCAL, "bilibili", signal());
    release.open();
    expect(await late).toEqual({ status: "expired" });
    expect(accountOf(s.h)).toBeUndefined();
  });

  it("replaces an existing login's Secret and marks it valid", async () => {
    const s = setup([POLL_CONFIRMED]);
    s.h.platformAccounts.putCookies(LOCAL, "bilibili", "amber_old_cookie=<placeholder>");
    const before = accountOf(s.h);
    const attempt = await s.service.start(LOCAL, "bilibili", signal());
    s.tick();
    expect(await s.service.status(LOCAL, "bilibili", attempt.attemptId, signal())).toEqual({ status: "confirmed" });
    expect(accountOf(s.h)).toMatchObject({ id: before?.id, credentialRef: before?.credentialRef, status: "valid" });
    expect(countRows(s.h.db, "secret")).toBe(1);
    expect(await s.h.platformAccounts.credentialFor(LOCAL.userId, "bilibili")?.cookies()).not.toContain("amber_old_cookie");
  });
});
