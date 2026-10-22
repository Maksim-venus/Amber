import { afterEach, describe, expect, it } from "vitest";
import { ServerAuthAdapter } from "../../../../../src/server/adapters/auth/server/index.ts";
import { SessionRevocations } from "../../../../../src/server/application/session-revocations.ts";
import { hashSessionId, newSessionId, SESSION_COOKIE } from "../../../../../src/server/domain/session.ts";
import { SESSION_SLIDING_DAYS, SESSION_TOUCH_INTERVAL_MIN } from "../../../../../src/shared/defaults.ts";
import { createHarness, type Harness } from "../../../../fixtures/pipeline/harness.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;
const DAY = 86_400_000;

function setup() {
  const h = createHarness();
  open.push(h);
  const clock = { now: T0 };
  const revocations = new SessionRevocations();
  const sessionId = newSessionId();
  const hash = hashSessionId(sessionId);
  h.repository.withTransaction((scope) => {
    scope.users.insert({ id: "alice", role: "admin", status: "active", createdAt: T0 });
    scope.users.putCredential({ userId: "alice", username: "alice", passwordHash: "<argon2id>", mustChangePassword: false });
    scope.sessions.insert({ sessionIdHash: hash, userId: "alice", createdAt: T0, lastSeenAt: T0, expiresAt: T0 + SESSION_SLIDING_DAYS * DAY });
  });
  const adapter = new ServerAuthAdapter({ repository: h.repository, revocations, now: () => clock.now });
  const request = { headers: { cookie: [SESSION_COOKIE, sessionId].join("=") } };
  return { h, clock, revocations, adapter, request, hash };
}

describe("ServerAuthAdapter", () => {
  it("slides the session only once the touch interval has passed, reporting the new expiry", () => {
    const { h, clock, adapter, request, hash } = setup();
    clock.now = T0 + SESSION_TOUCH_INTERVAL_MIN * MINUTE - 1;
    expect(adapter.authenticateWithSession(request)?.session).toEqual({ sessionIdHash: hash });
    clock.now = T0 + SESSION_TOUCH_INTERVAL_MIN * MINUTE;
    expect(adapter.authenticateWithSession(request)?.session).toEqual({ sessionIdHash: hash, renewedUntil: clock.now + SESSION_SLIDING_DAYS * DAY });
    expect(h.repository.withTransaction((scope) => scope.sessions.get(hash))?.lastSeenAt).toBe(clock.now);
  });

  it("refuses expired, revoked, in-process revoked and suspended-user sessions", () => {
    const expired = setup();
    expired.clock.now = T0 + SESSION_SLIDING_DAYS * DAY;
    expect(expired.adapter.authenticate(expired.request)).toBeNull();
    expect(expired.adapter.isSessionValid(expired.hash)).toBe(false);

    const revoked = setup();
    revoked.h.repository.withTransaction((scope) => scope.sessions.revoke(revoked.hash, T0));
    expect(revoked.adapter.authenticate(revoked.request)).toBeNull();

    const inProcess = setup();
    inProcess.revocations.add([inProcess.hash]);
    expect(inProcess.adapter.isRevoked(inProcess.hash)).toBe(true);
    expect(inProcess.adapter.authenticate(inProcess.request)).toBeNull();

    const suspended = setup();
    expect(suspended.adapter.isSessionValid(suspended.hash)).toBe(true);
    suspended.h.db.prepare("UPDATE user SET status = 'suspended' WHERE id = 'alice'").run();
    expect(suspended.adapter.authenticate(suspended.request)).toBeNull();
    expect(suspended.adapter.isSessionValid(suspended.hash)).toBe(false);
  });
});
