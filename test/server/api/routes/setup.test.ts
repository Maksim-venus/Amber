import { afterEach, describe, expect, it } from "vitest";
import { SETUP_TOKEN_TTL_MIN } from "../../../../src/shared/defaults.ts";
import { authMeDtoSchema } from "../../../../src/shared/dto/system.ts";
import { cookieOf, createServerApp, CSRF_HEADERS, PASSWORD, type ServerApp } from "../../../fixtures/server/server-app.ts";

const open: ServerApp[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

async function wizard(): Promise<ServerApp & { token: string }> {
  const s = await createServerApp({ setupToken: true });
  open.push(s);
  return Object.assign(s, { token: s.setupToken?.value ?? "" });
}

const admin = { username: "Admin", password: PASSWORD, displayName: "部署者" };

function setup(s: ServerApp, token: string | undefined, payload: object = admin) {
  return s.app.inject({
    method: "POST",
    url: "/api/setup",
    headers: { ...CSRF_HEADERS, ...(token === undefined ? {} : { "x-amber-setup-token": token }) },
    payload,
  });
}

describe("/api/setup", () => {
  it("refuses a missing, wrong or expired token without consuming the valid one", async () => {
    const s = await wizard();
    expect(s.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const token of [undefined, "", `${s.token}x`, s.token.replace(/^./, (c) => (c === "A" ? "B" : "A"))]) {
      const response = await setup(s, token);
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("unauthenticated.setup_token");
      const status = await s.app.inject({ method: "GET", url: "/api/setup", ...(token === undefined ? {} : { headers: { "x-amber-setup-token": token } }) });
      expect(status.statusCode).toBe(401);
    }
    // The token in the URL is not a token.
    expect((await s.app.inject({ method: "GET", url: `/api/setup?token=${s.token}` })).statusCode).toBe(401);
    expect(s.h.db.prepare("SELECT count(*) AS n FROM user_credential").get()).toEqual({ n: 0 });

    const status = await s.app.inject({ method: "GET", url: "/api/setup", headers: { "x-amber-setup-token": s.token } });
    expect(status.json()).toEqual({ initialized: false });
  });

  it("creates the first administrator with a session exactly once", async () => {
    const s = await wizard();
    const invalid = await setup(s, s.token, { ...admin, password: "short" });
    expect(invalid.statusCode).toBe(400);
    const created = await setup(s, s.token);
    expect(created.statusCode).toBe(201);
    const me = authMeDtoSchema.parse(created.json());
    expect(me).toMatchObject({ username: "admin", displayName: "部署者", role: "admin", mode: "server", mustChangePassword: false });
    expect(s.h.db.prepare("SELECT username FROM user_credential WHERE user_id = ?").get(me.userId)).toEqual({ username: "admin" });
    expect(s.h.db.prepare("SELECT display_name AS name FROM user WHERE id = ?").get(me.userId)).toEqual({ name: "部署者" });
    const cookie = cookieOf(created);
    expect((await s.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).json().userId).toBe(me.userId);

    // Once initialized: the status is public, a second setup conflicts, the token is spent.
    expect((await s.app.inject({ method: "GET", url: "/api/setup" })).json()).toEqual({ initialized: true });
    const again = await setup(s, s.token, { ...admin, username: "second" });
    expect(again.statusCode).toBe(409);
    expect(s.setupToken?.matches(s.token)).toBe(false);
  });

  it("lets only one of two concurrent setups win", async () => {
    const s = await wizard();
    const results = await Promise.all([setup(s, s.token), setup(s, s.token, { ...admin, username: "rival" })]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(s.h.db.prepare("SELECT count(*) AS n FROM user_credential").get()).toEqual({ n: 1 });
  });

  it("expires the token after SETUP_TOKEN_TTL_MIN", async () => {
    const s = await wizard();
    s.clock.now += SETUP_TOKEN_TTL_MIN * 60_000;
    expect((await setup(s, s.token)).statusCode).toBe(401);
  });

  it("requires the CSRF header like every unsafe request", async () => {
    const s = await wizard();
    const response = await s.app.inject({ method: "POST", url: "/api/setup", headers: { "x-amber-setup-token": s.token }, payload: admin });
    expect(response.json().error.code).toBe("unauthenticated.csrf");
  });

  it("has no token to accept when the instance was preset", async () => {
    const s = await createServerApp();
    open.push(s);
    expect((await s.app.inject({ method: "GET", url: "/api/setup" })).statusCode).toBe(401);
    await s.addUser("preset", { role: "admin" });
    expect((await s.app.inject({ method: "GET", url: "/api/setup" })).json()).toEqual({ initialized: true });
    expect((await setup(s, "anything")).statusCode).toBe(409);
  });
});
