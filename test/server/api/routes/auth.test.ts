import { afterEach, describe, expect, it } from "vitest";
import { LOGIN_BACKOFF_BASE_MS, LOGIN_BACKOFF_MAX_MS, LOGIN_RATE_PER_MIN, SESSION_SLIDING_DAYS, SESSION_TOUCH_INTERVAL_MIN } from "../../../../src/shared/defaults.ts";
import { authMeDtoSchema, versionDtoSchema } from "../../../../src/shared/dto/system.ts";
import { cookieOf, createServerApp, CSRF_HEADERS, PASSWORD, PUBLIC_ORIGIN, type ServerApp } from "../../../fixtures/server/server-app.ts";

const open: ServerApp[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

async function serverApp(options?: Parameters<typeof createServerApp>[0]): Promise<ServerApp> {
  const s = await createServerApp(options);
  open.push(s);
  return s;
}

const MINUTE = 60_000;
const DAY = 86_400_000;

describe("POST /api/auth/login", () => {
  it("sets a __Host- session cookie (Path=/, HttpOnly, Secure, SameSite=Lax, no Domain) and returns who logged in", async () => {
    const s = await serverApp();
    const id = await s.addUser("alice", { role: "admin" });
    const response = await s.app.inject({ method: "POST", url: "/api/auth/login", headers: CSRF_HEADERS, payload: { username: "  Alice ", password: PASSWORD } });
    expect(response.statusCode).toBe(200);
    expect(authMeDtoSchema.parse(response.json())).toEqual({ userId: id, username: "alice", role: "admin", mode: "server", mustChangePassword: false });
    const cookie = String(response.headers["set-cookie"]);
    expect(cookie).toMatch(/^__Host-amber-session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; SameSite=Lax/);
    expect(cookie).not.toMatch(/Domain=/i);
    // Only the hash of the session id is stored.
    const sessionId = cookieOf(response).split("=")[1] as string;
    const rows = s.h.db.prepare("SELECT session_id_hash FROM session").all() as Array<{ session_id_hash: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.session_id_hash).not.toContain(sessionId);

    const me = await s.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieOf(response) } });
    expect(me.json()).toEqual({ userId: id, username: "alice", role: "admin", mode: "server", mustChangePassword: false });
  });

  it("names the caller on /api/auth/me with the current display name", async () => {
    const s = await serverApp();
    const id = await s.addUser("alice");
    const cookie = await s.login("alice");
    s.h.repository.withTransaction((scope) => {
      const user = scope.users.get(id);
      if (user !== undefined) scope.users.update({ ...user, displayName: "Alice W." });
    });
    const me = await s.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(authMeDtoSchema.parse(me.json())).toEqual({ userId: id, username: "alice", displayName: "Alice W.", role: "user", mode: "server", mustChangePassword: false });
  });

  it("answers an unknown user and a wrong password identically", async () => {
    const s = await serverApp();
    await s.addUser("alice");
    const wrong = await s.app.inject({ method: "POST", url: "/api/auth/login", headers: CSRF_HEADERS, payload: { username: "alice", password: "wrong password!" } });
    const unknown = await s.app.inject({ method: "POST", url: "/api/auth/login", headers: CSRF_HEADERS, payload: { username: "nobody", password: PASSWORD } });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    expect(wrong.json().error.code).toBe("unauthenticated.bad_credentials");
    expect(wrong.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses a suspended account only after the password matched", async () => {
    const s = await serverApp();
    const id = await s.addUser("alice");
    s.h.db.prepare("UPDATE user SET status = 'suspended' WHERE id = ?").run(id);
    const wrong = await s.app.inject({ method: "POST", url: "/api/auth/login", headers: CSRF_HEADERS, payload: { username: "alice", password: "wrong password!" } });
    expect(wrong.json().error.code).toBe("unauthenticated.bad_credentials");
    const right = await s.app.inject({ method: "POST", url: "/api/auth/login", headers: CSRF_HEADERS, payload: { username: "alice", password: PASSWORD } });
    expect(right.statusCode).toBe(403);
    expect(right.json().error.code).toBe("forbidden.account_suspended");
  });

  it("cleans expired and revoked sessions on every login attempt", async () => {
    const s = await serverApp();
    await s.addUser("alice");
    await s.login("alice");
    const second = await s.login("alice");
    await s.app.inject({ method: "POST", url: "/api/auth/logout", headers: { ...CSRF_HEADERS, cookie: second } });
    s.clock.now += SESSION_SLIDING_DAYS * DAY;
    await s.app.inject({ method: "POST", url: "/api/auth/login", headers: CSRF_HEADERS, payload: { username: "alice", password: "wrong password!" } });
    expect(s.h.db.prepare("SELECT count(*) AS n FROM session").get()).toEqual({ n: 0 });
  });
});

describe("login throttling", () => {
  async function fail(s: ServerApp, username: string, headers: Record<string, string> = {}) {
    return s.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { ...CSRF_HEADERS, ...headers },
      payload: { username, password: "wrong password!" },
      remoteAddress: headers["x-test-peer"] ?? "198.51.100.7",
    });
  }

  it("answers 429 with an exponentially growing Retry-After once failures exceed LOGIN_RATE_PER_MIN", async () => {
    const s = await serverApp();
    await s.addUser("alice");
    for (let attempt = 0; attempt < LOGIN_RATE_PER_MIN; attempt += 1) {
      expect((await fail(s, "alice")).statusCode).toBe(401);
    }
    const retryAfters: number[] = [];
    for (let k = 1; k <= 4; k += 1) {
      const limited = await fail(s, "alice");
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.class).toBe("rate_limited");
      retryAfters.push(Number(limited.headers["retry-after"]));
    }
    expect(retryAfters).toEqual([1, 2, 4, 8].map((factor) => Math.ceil(Math.min(LOGIN_BACKOFF_BASE_MS * factor, LOGIN_BACKOFF_MAX_MS) / 1000)));
    // Even the right password waits out the backoff.
    const blocked = await s.app.inject({ method: "POST", url: "/api/auth/login", headers: CSRF_HEADERS, payload: { username: "alice", password: PASSWORD }, remoteAddress: "203.0.113.9" });
    expect(blocked.statusCode).toBe(429);
  });

  it("caps the backoff at LOGIN_BACKOFF_MAX_MS and forgets failures after the window", async () => {
    const s = await serverApp();
    for (let attempt = 0; attempt < LOGIN_RATE_PER_MIN; attempt += 1) await fail(s, "ghost");
    let last = 0;
    for (let k = 0; k < 20; k += 1) last = Number((await fail(s, "ghost")).headers["retry-after"]);
    expect(last).toBe(Math.ceil(LOGIN_BACKOFF_MAX_MS / 1000));
    s.clock.now += LOGIN_BACKOFF_MAX_MS + MINUTE;
    expect((await fail(s, "ghost")).statusCode).toBe(401);
  });

  it("counts per source IP across usernames, and a success clears only the username bucket", async () => {
    const s = await serverApp();
    await s.addUser("alice");
    for (let attempt = 0; attempt < LOGIN_RATE_PER_MIN - 1; attempt += 1) await fail(s, "alice");
    const ok = await s.app.inject({ method: "POST", url: "/api/auth/login", headers: CSRF_HEADERS, payload: { username: "alice", password: PASSWORD }, remoteAddress: "192.0.2.50" });
    expect(ok.statusCode).toBe(200);
    // The username bucket was cleared by the success; the attacker IP still has its failures.
    expect((await fail(s, "alice", { "x-test-peer": "192.0.2.51" })).statusCode).toBe(401);
    expect((await fail(s, `other-${1}`)).statusCode).toBe(401);
    expect((await fail(s, "other-2")).statusCode).toBe(429);
  });

  it("takes the rightmost X-Forwarded-For hop only from a trusted proxy", async () => {
    const s = await serverApp({ trustedProxyCidrs: ["10.0.0.0/8"] });
    const viaProxy = (client: string) => ({ "x-test-peer": "10.1.2.3", "x-forwarded-for": `1.1.1.1, ${client}` });
    for (let attempt = 0; attempt < LOGIN_RATE_PER_MIN; attempt += 1) await fail(s, `user-${attempt}`, viaProxy("192.0.2.1"));
    expect((await fail(s, "user-x", viaProxy("192.0.2.1"))).statusCode).toBe(429);
    // Another client behind the same proxy has its own bucket.
    expect((await fail(s, "user-y", viaProxy("192.0.2.2"))).statusCode).toBe(401);
    // An untrusted peer cannot pick its bucket with a forged header.
    for (let attempt = 0; attempt < LOGIN_RATE_PER_MIN; attempt += 1) {
      await fail(s, `forger-${attempt}`, { "x-test-peer": "203.0.113.5", "x-forwarded-for": `192.0.2.${100 + attempt}` });
    }
    expect((await fail(s, "forger-x", { "x-test-peer": "203.0.113.5", "x-forwarded-for": "192.0.2.200" })).statusCode).toBe(429);
  });
});

describe("POST /api/auth/logout", () => {
  it("revokes the session and clears the cookie", async () => {
    const s = await serverApp();
    await s.addUser("alice");
    const cookie = await s.login("alice");
    const response = await s.app.inject({ method: "POST", url: "/api/auth/logout", headers: { ...CSRF_HEADERS, cookie } });
    expect(response.statusCode).toBe(204);
    expect(String(response.headers["set-cookie"])).toMatch(/^__Host-amber-session=;.*Expires=Thu, 01 Jan 1970/);
    expect((await s.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).statusCode).toBe(401);
  });
});

describe("POST /api/auth/change-password and the forced change", () => {
  it("admits only me / logout / change-password until the password is changed, then everything", async () => {
    const s = await serverApp();
    await s.addUser("alice", { mustChangePassword: true });
    const cookie = await s.login("alice");
    const other = await s.login("alice");
    expect((await s.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).json().mustChangePassword).toBe(true);
    for (const [method, url] of [["GET", "/api/tasks"], ["GET", "/api/settings"], ["GET", "/api/nope"], ["POST", "/api/contents/inspect"]] as const) {
      const blocked = await s.app.inject({ method, url, headers: { ...CSRF_HEADERS, cookie } });
      expect(blocked.statusCode, url).toBe(403);
      expect(blocked.json().error.code).toBe("forbidden.must_change_password");
    }

    const short = await s.app.inject({ method: "POST", url: "/api/auth/change-password", headers: { ...CSRF_HEADERS, cookie }, payload: { currentPassword: PASSWORD, newPassword: "short" } });
    expect(short.statusCode).toBe(400);
    const mismatch = await s.app.inject({ method: "POST", url: "/api/auth/change-password", headers: { ...CSRF_HEADERS, cookie }, payload: { currentPassword: "not it at all", newPassword: "a new long password" } });
    expect(mismatch.statusCode).toBe(400);
    const changed = await s.app.inject({ method: "POST", url: "/api/auth/change-password", headers: { ...CSRF_HEADERS, cookie }, payload: { currentPassword: PASSWORD, newPassword: "a new long password" } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ username: "alice", mustChangePassword: false });

    expect((await s.app.inject({ method: "GET", url: "/api/tasks", headers: { cookie } })).statusCode).toBe(200);
    // The caller's other sessions are revoked; the new password works, the old one does not.
    expect((await s.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: other } })).statusCode).toBe(401);
    await expect(s.login("alice")).rejects.toThrow(/401/);
    await s.login("alice", "a new long password");
  });
});

describe("sessions", () => {
  it("slide: lastSeenAt is written at most every SESSION_TOUCH_INTERVAL_MIN and the cookie re-issued", async () => {
    const s = await serverApp();
    await s.addUser("alice");
    const cookie = await s.login("alice");
    const loginAt = s.clock.now;
    s.clock.now += (SESSION_TOUCH_INTERVAL_MIN - 1) * MINUTE;
    const early = await s.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(early.headers["set-cookie"]).toBeUndefined();
    expect(s.h.db.prepare("SELECT last_seen_at AS at FROM session").get()).toEqual({ at: loginAt });
    s.clock.now += 2 * MINUTE;
    const late = await s.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(String(late.headers["set-cookie"])).toContain(cookie);
    expect(s.h.db.prepare("SELECT last_seen_at AS at, expires_at AS until FROM session").get()).toEqual({
      at: s.clock.now,
      until: s.clock.now + SESSION_SLIDING_DAYS * DAY,
    });
  });

  it("expire after SESSION_SLIDING_DAYS without use, and die with a suspension or revocation", async () => {
    const s = await serverApp();
    const id = await s.addUser("alice");
    const idle = await s.login("alice");
    s.clock.now += SESSION_SLIDING_DAYS * DAY;
    expect((await s.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: idle } })).statusCode).toBe(401);

    const revokedInProcess = await s.login("alice");
    const revokedInDb = await s.login("alice");
    const suspended = await s.login("alice");
    const hashes = s.h.repository.withTransaction((scope) => scope.sessions.revokeAllOf(id, s.clock.now));
    // In-process set alone (as after a revocation committed by this process) …
    s.revocations.add(hashes.slice(0, 1));
    for (const cookie of [revokedInProcess, revokedInDb, suspended]) {
      expect((await s.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).statusCode).toBe(401);
    }
    // … and a suspended user with a live session row is refused too.
    const fresh = await s.login("alice");
    s.h.db.prepare("UPDATE user SET status = 'suspended' WHERE id = ?").run(id);
    expect((await s.app.inject({ method: "GET", url: "/api/tasks", headers: { cookie: fresh } })).statusCode).toBe(401);
  });
});

describe("CSRF on unsafe methods", () => {
  async function post(s: ServerApp, headers: Record<string, string>, payload: unknown = {}) {
    return s.app.inject({ method: "POST", url: "/api/collections", headers, payload: payload as object });
  }

  it("refuses each broken rule and admits a compliant request", async () => {
    const s = await serverApp();
    await s.addUser("alice");
    const cookie = await s.login("alice");
    const body = { name: "course" };
    const cases: Array<[string, Record<string, string>, string | undefined]> = [
      ["no custom header", { cookie, origin: PUBLIC_ORIGIN }, undefined],
      ["wrong custom header", { cookie, origin: PUBLIC_ORIGIN, "x-amber-request": "yes" }, undefined],
      ["foreign Origin", { cookie, origin: "https://evil.example", "x-amber-request": "1" }, undefined],
      ["null Origin", { cookie, origin: "null", "x-amber-request": "1" }, undefined],
      ["cross-site fetch", { cookie, origin: PUBLIC_ORIGIN, "x-amber-request": "1", "sec-fetch-site": "cross-site" }, undefined],
      ["same-site without Origin or Referer", { cookie, "x-amber-request": "1", "sec-fetch-site": "same-site" }, undefined],
      ["no Fetch Metadata, Origin or Referer", { cookie, "x-amber-request": "1" }, undefined],
      ["foreign Referer", { cookie, "x-amber-request": "1", referer: "https://evil.example/page" }, undefined],
    ];
    for (const [name, headers] of cases) {
      const response = await post(s, headers, body);
      expect(response.statusCode, name).toBe(401);
      expect(response.json().error.code, name).toBe("unauthenticated.csrf");
    }
    for (const contentType of ["application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/plain;charset=UTF-8"]) {
      const response = await s.app.inject({ method: "POST", url: "/api/collections", headers: { ...CSRF_HEADERS, cookie, "content-type": contentType }, payload: "name=course" });
      expect(response.statusCode, contentType).toBe(401);
      expect(response.json().error.code).toBe("unauthenticated.csrf");
    }

    expect((await post(s, { ...CSRF_HEADERS, cookie }, body)).statusCode).toBe(201);
    expect((await post(s, { ...CSRF_HEADERS, cookie, "sec-fetch-site": "same-origin" }, body)).statusCode).toBe(201);
    // Without Fetch Metadata and Origin, a same-origin Referer suffices.
    expect((await post(s, { cookie, "x-amber-request": "1", referer: `${PUBLIC_ORIGIN}/library` }, body)).statusCode).toBe(201);
  });

  it("guards login itself, and safe methods need no CSRF header", async () => {
    const s = await serverApp();
    await s.addUser("alice");
    const forged = await s.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: "https://evil.example", "x-amber-request": "1" }, payload: { username: "alice", password: PASSWORD } });
    expect(forged.json().error.code).toBe("unauthenticated.csrf");
    const cookie = await s.login("alice");
    expect((await s.app.inject({ method: "GET", url: "/api/collections", headers: { cookie } })).statusCode).toBe(200);
  });
});

describe("unauthenticated surface", () => {
  it("serves health and version without a cookie and without sensitive fields", async () => {
    const s = await serverApp();
    const health = await s.app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });
    const version = await s.app.inject({ method: "GET", url: "/api/version" });
    expect(version.statusCode).toBe(200);
    expect(versionDtoSchema.strict().parse(version.json())).toEqual({ version: "0.0.0-test", mode: "server" });
    for (const body of [health.body, version.body]) {
      expect(body).not.toMatch(/\/|\\|user|cookie|token|key|password|secret/i);
    }
  });

  it("answers 401 for every other endpoint without a cookie, unknown /api paths included, and 404 for those with one", async () => {
    const s = await serverApp();
    await s.addUser("alice");
    for (const [method, url] of [["GET", "/api/auth/me"], ["GET", "/api/tasks"], ["GET", "/api/settings"], ["GET", "/api/nope"], ["DELETE", "/api/nope"], ["GET", "/api/%74asks"]] as const) {
      const response = await s.app.inject({ method, url, headers: method === "GET" ? {} : CSRF_HEADERS });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.json().error.class).toBe("unauthenticated");
    }
    const cookie = await s.login("alice");
    const unknown = await s.app.inject({ method: "GET", url: "/api/nope", headers: { cookie } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.class).toBe("not_found");
  });

  it("leaves paths outside /api to static hosting", async () => {
    const s = await serverApp();
    expect((await s.app.inject({ method: "GET", url: "/library" })).statusCode).toBe(404);
  });
});

describe("local mode", () => {
  it("keeps logout as a no-op and has no login or setup routes", async () => {
    const { createHarness, LOCAL_TOKEN } = await import("../../../fixtures/pipeline/harness.ts");
    const h = createHarness();
    try {
      const { app } = await h.app();
      const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
      expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers: auth })).statusCode).toBe(204);
      expect((await app.inject({ method: "POST", url: "/api/auth/logout" })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/auth/login", headers: auth, payload: { username: "a", password: "b" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/api/setup", headers: auth })).statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });
});
