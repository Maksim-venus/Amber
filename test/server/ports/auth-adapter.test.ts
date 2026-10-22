import { afterEach, describe, expect, it } from "vitest";
import { LocalAuthAdapter } from "../../../src/server/adapters/auth/local/index.ts";
import { ServerAuthAdapter } from "../../../src/server/adapters/auth/server/index.ts";
import { SessionRevocations } from "../../../src/server/application/session-revocations.ts";
import { hashSessionId, newSessionId, SESSION_COOKIE } from "../../../src/server/domain/session.ts";
import type { AuthAdapter, AuthRequest } from "../../../src/server/ports/auth-adapter.ts";
import type { RequestPrincipal } from "../../../src/server/domain/user.ts";
import { createHarness, type Harness } from "../../fixtures/pipeline/harness.ts";

/**
 * The AuthAdapter contract both modes must honour: a valid credential maps
 * to exactly one `RequestPrincipal` of the adapter's mode, everything else is `null`, and
 * the principal carries nothing beyond its four fields.
 */
interface Subject {
  adapter: AuthAdapter;
  valid: AuthRequest;
  invalid: AuthRequest[];
  expected: RequestPrincipal;
  /** Makes the valid credential stop working the way the mode allows. */
  invalidate(): void;
}

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

const TOKEN = "t".repeat(64);

/** A `Cookie` header carrying the session cookie, optionally after another cookie pair. */
function cookieHeader(value: string, before?: string): { cookie: string } {
  const pair = [SESSION_COOKIE, value].join("=");
  return { cookie: before === undefined ? pair : `${before}; ${pair}` };
}

const subjects: Record<string, () => Subject> = {
  local: () => {
    let token = TOKEN;
    const adapter: AuthAdapter = {
      authenticate: (request) => new LocalAuthAdapter(token).authenticate(request),
    };
    return {
      adapter,
      valid: { headers: { authorization: `Bearer ${TOKEN}` } },
      invalid: [{ headers: {} }, { headers: { authorization: `Bearer ${"u".repeat(64)}` } }, { headers: cookieHeader(TOKEN) }],
      expected: { userId: "local", mode: "local", role: "admin", mustChangePassword: false },
      // A restarted sidecar has a new token.
      invalidate: () => {
        token = "n".repeat(64);
      },
    };
  },
  server: () => {
    const h = createHarness();
    open.push(h);
    const revocations = new SessionRevocations();
    const sessionId = newSessionId();
    h.repository.withTransaction((scope) => {
      scope.users.insert({ id: "alice", role: "user", status: "active", createdAt: 1 });
      scope.users.putCredential({ userId: "alice", username: "alice", passwordHash: "<argon2id>", mustChangePassword: true });
      scope.sessions.insert({ sessionIdHash: hashSessionId(sessionId), userId: "alice", createdAt: 1, lastSeenAt: Date.now(), expiresAt: Date.now() + 60_000 });
    });
    return {
      adapter: new ServerAuthAdapter({ repository: h.repository, revocations }),
      valid: { headers: cookieHeader(sessionId, "theme=dark") },
      invalid: [
        { headers: {} },
        { headers: cookieHeader(newSessionId()) },
        { headers: cookieHeader(sessionId, [SESSION_COOKIE, sessionId].join("=")) },
        { headers: { authorization: `Bearer ${sessionId}` } },
      ],
      expected: { userId: "alice", mode: "server", role: "user", mustChangePassword: true },
      invalidate: () => revocations.add([hashSessionId(sessionId)]),
    };
  },
};

describe.each(Object.keys(subjects))("AuthAdapter contract: %s", (mode) => {
  it("maps a valid credential to exactly the principal of its mode", () => {
    const subject = (subjects[mode] as () => Subject)();
    const principal = subject.adapter.authenticate(subject.valid);
    expect(principal).toStrictEqual(subject.expected);
    expect(Object.keys(principal ?? {}).sort()).toEqual(["mode", "mustChangePassword", "role", "userId"]);
    expect(principal?.mode).toBe(mode);
  });

  it("answers null for missing, wrong or foreign-mode credentials", () => {
    const subject = (subjects[mode] as () => Subject)();
    for (const request of subject.invalid) {
      expect(subject.adapter.authenticate(request)).toBeNull();
    }
  });

  it("answers null once the credential is invalidated", () => {
    const subject = (subjects[mode] as () => Subject)();
    subject.invalidate();
    expect(subject.adapter.authenticate(subject.valid)).toBeNull();
  });

  it("names the session only where sessions exist", () => {
    const subject = (subjects[mode] as () => Subject)();
    const authentication = subject.adapter.authenticateWithSession?.(subject.valid);
    if (mode === "server") {
      expect(authentication?.principal).toStrictEqual(subject.expected);
      expect(authentication?.session?.sessionIdHash).toMatch(/^[0-9a-f]{64}$/);
    } else {
      expect(authentication).toBeUndefined();
    }
  });
});
