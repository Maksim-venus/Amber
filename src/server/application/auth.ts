import { randomBytes } from "node:crypto";
import { monotonicFactory } from "ulid";
import { SESSION_SLIDING_DAYS } from "../../shared/defaults.ts";
import type { AuthMeDto, SetupStatusDto } from "../../shared/dto/system.ts";
import { amberError } from "../domain/errors.ts";
import { hashSessionId, newSessionId } from "../domain/session.ts";
import { isAcceptablePassword, normalizeUsername, type RequestPrincipal, type User } from "../domain/user.ts";
import type { SetupTokenGate } from "../ports/auth-adapter.ts";
import type { PasswordHasher } from "../ports/password-hasher.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import type { SessionRevocations } from "./session-revocations.ts";

const MS_PER_DAY = 86_400_000;

/** A session just created; `sessionId` goes into the cookie and nowhere else. */
export interface IssuedSession {
  sessionId: string;
  expiresAt: number;
}

export interface LoginInput {
  username: string;
  password: string;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export interface SetupInput {
  username: string;
  password: string;
  displayName?: string;
}

export interface AuthServiceOptions {
  repository: Repository;
  hasher: PasswordHasher;
  revocations: SessionRevocations;
  /** The wizard's one-time token; absent when the instance was initialized before this start. */
  setupToken?: SetupTokenGate;
  now?: () => number;
  newId?: () => string;
}

/**
 * Server-mode login, logout, password change and the first-administrator wizard. Failures
 * never tell whether a username exists: an unknown name is verified against a dummy hash so
 * it costs the same time as a wrong password.
 */
export class AuthService {
  private readonly options: AuthServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;
  private dummyHash: Promise<string> | undefined;

  constructor(options: AuthServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
  }

  /** The caller as the account menu shows them: the principal plus their login and display names. */
  me(principal: RequestPrincipal): AuthMeDto {
    const { userId, role, mode, mustChangePassword } = principal;
    const names = this.options.repository.withTransaction((scope) => ({
      displayName: scope.users.get(userId)?.displayName,
      username: scope.users.getCredential(userId)?.username,
    }));
    return {
      userId,
      ...(names.username === undefined ? {} : { username: names.username }),
      ...(names.displayName === undefined ? {} : { displayName: names.displayName }),
      role,
      mode,
      mustChangePassword,
    };
  }

  async login(input: LoginInput): Promise<{ me: AuthMeDto; session: IssuedSession }> {
    const { repository, hasher } = this.options;
    // Expired and revoked rows are cleaned up on login attempts; there is no timer.
    repository.withTransaction((scope) => scope.sessions.deleteStale(this.now()));
    const username = normalizeUsername(input.username);
    const credential = username === undefined ? undefined : repository.withTransaction((scope) => scope.users.findCredentialByUsername(username));
    const verdict = await hasher.verify(credential?.passwordHash ?? (await this.dummy()), input.password);
    if (credential === undefined || !verdict.valid) {
      throw amberError("unauthenticated", "bad credentials", { code: "unauthenticated.bad_credentials" });
    }
    const rehashed = verdict.needsRehash ? await hasher.hash(input.password) : undefined;
    return repository.withTransaction((scope) => {
      const user = scope.users.get(credential.userId);
      if (user === undefined) {
        throw amberError("unauthenticated", "bad credentials", { code: "unauthenticated.bad_credentials" });
      }
      if (user.status !== "active") {
        throw amberError("forbidden", "account suspended", { code: "forbidden.account_suspended" });
      }
      const current = scope.users.getCredential(user.id) ?? credential;
      if (rehashed !== undefined && current.passwordHash === credential.passwordHash) {
        scope.users.putCredential({ ...current, passwordHash: rehashed });
      }
      return { me: this.meOf(user, current.username, current.mustChangePassword), session: this.issue(scope, user.id) };
    });
  }

  /** Revokes the session that made the request. */
  logout(sessionIdHash: string | undefined): void {
    if (sessionIdHash === undefined) {
      return;
    }
    this.options.repository.withTransaction((scope) => scope.sessions.revoke(sessionIdHash, this.now()));
    this.options.revocations.add([sessionIdHash]);
  }

  /** Changes the caller's own password and revokes their other sessions. */
  async changePassword(principal: RequestPrincipal, sessionIdHash: string | undefined, input: ChangePasswordInput): Promise<AuthMeDto> {
    const { repository, hasher } = this.options;
    const credential = repository.withTransaction((scope) => scope.users.getCredential(principal.userId));
    if (credential === undefined) {
      throw amberError("forbidden", "no login credential");
    }
    const verdict = await hasher.verify(credential.passwordHash, input.currentPassword);
    if (!verdict.valid) {
      // Not 401: the caller is authenticated, only the confirmation is wrong.
      throw amberError("invalid_request", "current password does not match", { params: { detail: "currentPassword" } });
    }
    if (!isAcceptablePassword(input.newPassword)) {
      throw amberError("invalid_request", "new password too short", { params: { detail: "newPassword" } });
    }
    const passwordHash = await hasher.hash(input.newPassword);
    const revoked = repository.withTransaction((scope) => {
      const current = scope.users.getCredential(principal.userId);
      if (current === undefined || current.passwordHash !== credential.passwordHash) {
        throw amberError("conflict", "password changed concurrently");
      }
      scope.users.putCredential({ ...current, passwordHash, mustChangePassword: false });
      return scope.sessions.revokeAllOf(principal.userId, this.now(), sessionIdHash === undefined ? {} : { except: sessionIdHash });
    });
    this.options.revocations.add(revoked);
    return { ...this.me(principal), mustChangePassword: false };
  }

  /**
   * `GET /api/setup`, which needs no authentication: an initialized instance says so to
   * anyone, the token being spent; before that only a valid setup token gets an answer.
   */
  setupStatus(presentedToken: string | undefined): SetupStatusDto {
    if (this.initialized()) {
      return { initialized: true };
    }
    this.requireSetupToken(presentedToken);
    return { initialized: false };
  }

  /** `POST /api/setup`: the first administrator and their session; the token is spent. */
  async setup(presentedToken: string | undefined, input: SetupInput): Promise<{ me: AuthMeDto; session: IssuedSession }> {
    if (this.initialized()) {
      throw amberError("conflict", "instance already initialized");
    }
    this.requireSetupToken(presentedToken);
    const username = requireUsername(input.username);
    requirePassword(input.password, "password");
    const passwordHash = await this.options.hasher.hash(input.password);
    const result = this.options.repository.withTransaction((scope) => {
      // Re-checked here: another request may have completed setup while this one hashed.
      if (scope.users.anyCredential()) {
        throw amberError("conflict", "instance already initialized");
      }
      if (!this.options.setupToken?.matches(presentedToken)) {
        throw amberError("unauthenticated", "setup token rejected", { code: "unauthenticated.setup_token" });
      }
      const user: User = {
        id: this.newId(),
        role: "admin",
        status: "active",
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        createdAt: this.now(),
      };
      scope.users.insert(user);
      scope.users.putCredential({ userId: user.id, username, passwordHash, mustChangePassword: false });
      return { me: this.meOf(user, username, false), session: this.issue(scope, user.id) };
    });
    this.options.setupToken?.consume();
    return result;
  }

  private initialized(): boolean {
    return this.options.repository.withTransaction((scope) => scope.users.anyCredential());
  }

  private requireSetupToken(presented: string | undefined): void {
    if (!this.options.setupToken?.matches(presented)) {
      throw amberError("unauthenticated", "setup token rejected", { code: "unauthenticated.setup_token" });
    }
  }

  private issue(scope: RepositoryScope, userId: string): IssuedSession {
    const now = this.now();
    const sessionId = newSessionId();
    const expiresAt = now + SESSION_SLIDING_DAYS * MS_PER_DAY;
    scope.sessions.insert({ sessionIdHash: hashSessionId(sessionId), userId, createdAt: now, lastSeenAt: now, expiresAt });
    return { sessionId, expiresAt };
  }

  private meOf(user: User, username: string, mustChangePassword: boolean): AuthMeDto {
    return {
      userId: user.id,
      username,
      ...(user.displayName === undefined ? {} : { displayName: user.displayName }),
      role: user.role,
      mode: "server",
      mustChangePassword,
    };
  }

  /** A hash of a random password, made once, so unknown usernames cost a full verification. */
  private dummy(): Promise<string> {
    this.dummyHash ??= this.options.hasher.hash(randomBytes(16).toString("base64url"));
    return this.dummyHash;
  }
}

function requireUsername(raw: string): string {
  const username = normalizeUsername(raw);
  if (username === undefined) {
    throw amberError("invalid_request", "unacceptable username", { params: { detail: "username" } });
  }
  return username;
}

function requirePassword(password: string, field: string): void {
  if (!isAcceptablePassword(password)) {
    throw amberError("invalid_request", "password too short", { params: { detail: field } });
  }
}

export const ADMIN_USERNAME_ENV = "AMBER_ADMIN_USERNAME";
export const ADMIN_PASSWORD_ENV = "AMBER_ADMIN_PASSWORD";

export type AdminBootstrapOutcome = "initialized" | "preset_admin_created" | "setup_required";

/**
 * Start-up of server mode: an instance that already has a login
 * credential is left alone; otherwise `AMBER_ADMIN_USERNAME` / `AMBER_ADMIN_PASSWORD`, when
 * both are set, create the first administrator with a forced password change, and without
 * them the caller opens the wizard with a setup token. The plaintext variables are removed
 * from `env` in every case. An unacceptable preset fails start-up without echoing values.
 */
export async function ensureAdminBootstrap(options: {
  repository: Repository;
  hasher: PasswordHasher;
  env: NodeJS.ProcessEnv;
  now?: () => number;
  newId?: () => string;
}): Promise<AdminBootstrapOutcome> {
  const { repository, hasher, env } = options;
  const rawUsername = env[ADMIN_USERNAME_ENV];
  const password = env[ADMIN_PASSWORD_ENV];
  delete env[ADMIN_USERNAME_ENV];
  delete env[ADMIN_PASSWORD_ENV];
  if (repository.withTransaction((scope) => scope.users.anyCredential())) {
    return "initialized";
  }
  if (rawUsername === undefined && password === undefined) {
    return "setup_required";
  }
  if (rawUsername === undefined || password === undefined) {
    throw new Error(`${ADMIN_USERNAME_ENV} and ${ADMIN_PASSWORD_ENV} must be set together`);
  }
  const username = normalizeUsername(rawUsername);
  if (username === undefined) {
    throw new Error(`${ADMIN_USERNAME_ENV} must normalize to 3–32 characters of [a-z0-9._-]`);
  }
  if (!isAcceptablePassword(password)) {
    throw new Error(`${ADMIN_PASSWORD_ENV} is shorter than the minimum password length`);
  }
  const passwordHash = await hasher.hash(password);
  const now = options.now ?? Date.now;
  const id = (options.newId ?? monotonicFactory())();
  repository.withTransaction((scope) => {
    scope.users.insert({ id, role: "admin", status: "active", createdAt: now() });
    scope.users.putCredential({ userId: id, username, passwordHash, mustChangePassword: true });
  });
  return "preset_admin_created";
}
