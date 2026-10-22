import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { Argon2PasswordHasher } from "../../../src/server/adapters/auth/server/password.ts";
import { ServerAuthAdapter } from "../../../src/server/adapters/auth/server/index.ts";
import { SetupToken } from "../../../src/server/adapters/auth/server/setup-token.ts";
import { buildApp } from "../../../src/server/app.ts";
import { AuthService } from "../../../src/server/application/auth.ts";
import type { PlatformQrLoginService } from "../../../src/server/application/platform-qr-login.ts";
import { SessionRevocations } from "../../../src/server/application/session-revocations.ts";
import { LoginRateLimiter } from "../../../src/server/api/login-rate-limit.ts";
import type { UserRole } from "../../../src/shared/enums.ts";
import { createHarness, type Harness } from "../pipeline/harness.ts";

/**
 * A server-mode app on a temporary database with the real session adapter, auth service,
 * CSRF checks and login throttling. argon2id runs with minimal cost parameters so tests
 * stay fast; one adapter test covers the production parameters.
 */

export const PUBLIC_ORIGIN = "https://amber.example";
/** What the SPA sends with every unsafe request to pass the CSRF check. */
export const CSRF_HEADERS = { "x-amber-request": "1", origin: PUBLIC_ORIGIN } as const;
export const PASSWORD = "correct horse battery";
export const FAST_ARGON2 = { memoryKiB: 8, iterations: 1, parallelism: 1 };

export interface Clock {
  now: number;
}

export interface ServerApp {
  h: Harness;
  app: FastifyInstance;
  auth: AuthService;
  adapter: ServerAuthAdapter;
  revocations: SessionRevocations;
  hasher: Argon2PasswordHasher;
  setupToken: SetupToken | undefined;
  clock: Clock;
  /** A user with a login credential; returns its id. */
  addUser(username: string, options?: { role?: UserRole; password?: string; mustChangePassword?: boolean; id?: string }): Promise<string>;
  /** Logs in through the API and returns the `Cookie` header value. */
  login(username: string, password?: string): Promise<string>;
  close(): Promise<void>;
}

export async function createServerApp(
  options: {
    setupToken?: boolean;
    trustedProxyCidrs?: readonly string[];
    log?: { write(line: string): void };
    /** Also serves the platform account routes, QR login through this service. */
    platformQrLogin?: (h: Harness, clock: Clock) => PlatformQrLoginService;
  } = {},
): Promise<ServerApp> {
  const h = createHarness();
  const clock: Clock = { now: 1_800_000_000_000 };
  const now = (): number => clock.now;
  const revocations = new SessionRevocations();
  const hasher = new Argon2PasswordHasher(FAST_ARGON2);
  const setupToken = options.setupToken === true ? new SetupToken({ now }) : undefined;
  const auth = new AuthService({
    repository: h.repository,
    hasher,
    revocations,
    ...(setupToken === undefined ? {} : { setupToken }),
    now,
    newId: h.newId,
  });
  const adapter = new ServerAuthAdapter({ repository: h.repository, revocations, now });
  const { app } = await buildApp({
    mode: "server",
    auth: adapter,
    serverAuth: {
      service: auth,
      publicOrigin: PUBLIC_ORIGIN,
      loginLimiter: new LoginRateLimiter({ now }),
      ...(options.trustedProxyCidrs === undefined ? {} : { trustedProxyCidrs: options.trustedProxyCidrs }),
    },
    bus: h.bus,
    tasks: h.tasks,
    instanceSettings: h.settings,
    settings: h.userSettings,
    contents: h.contents,
    collections: h.collections,
    chat: h.chat,
    ...(options.platformQrLogin === undefined ? {} : { platformAccounts: h.platformAccounts, platformQrLogin: options.platformQrLogin(h, clock) }),
    version: "0.0.0-test",
    log: options.log === undefined ? false : { level: "info", destination: options.log },
  });
  const server: ServerApp = {
    h,
    app,
    auth,
    adapter,
    revocations,
    hasher,
    setupToken,
    clock,
    async addUser(username, userOptions = {}) {
      const id = userOptions.id ?? h.newId();
      const passwordHash = await hasher.hash(userOptions.password ?? PASSWORD);
      h.repository.withTransaction((scope) => {
        scope.users.insert({ id, role: userOptions.role ?? "user", status: "active", createdAt: clock.now });
        scope.users.putCredential({ userId: id, username, passwordHash, mustChangePassword: userOptions.mustChangePassword ?? false });
      });
      return id;
    },
    async login(username, password = PASSWORD) {
      const response = await app.inject({ method: "POST", url: "/api/auth/login", headers: CSRF_HEADERS, payload: { username, password } });
      if (response.statusCode !== 200) {
        throw new Error(`login failed: ${response.statusCode} ${response.body}`);
      }
      return cookieOf(response);
    },
    async close() {
      await app.close();
      await h.close();
    },
  };
  return server;
}

/** `name=value` of the session cookie a response sets, ready for a `Cookie` header. */
export function cookieOf(response: LightMyRequestResponse): string {
  const header = response.headers["set-cookie"];
  const first = Array.isArray(header) ? header[0] : header;
  if (first === undefined) {
    throw new Error("no Set-Cookie in response");
  }
  return first.split(";")[0] as string;
}
